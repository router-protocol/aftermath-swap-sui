import { Aftermath, Router } from "aftermath-ts-sdk";
import { Network, Trade, TurbosSdk } from "turbos-clmm-sdk";
import { ethers } from "ethers";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import axios from "axios";
import { BCS, getSuiMoveConfig } from "@mysten/bcs";
import { AggregatorQuoter, TradeBuilder } from "@flowx-finance/sdk";
const bcs = new BCS(getSuiMoveConfig());


/////////////////////////////////////////////////////////////////////////////
//////////////////////////// Sign and Send ////////////////////////////////
///////////////////////////////////////////////////////////////////////////
async function signAndSendTx(client: SuiClient, txb: Transaction | Uint8Array, signer: Ed25519Keypair) {
  return await client.signAndExecuteTransaction({
    transaction: txb,
    signer,
    requestType: "WaitForLocalExecution",
    options: {
      showEffects: true,
      showEvents: true,
      showRawInput: true,
      showInput: true,
      showBalanceChanges: true,
      showObjectChanges: true,
    },
  });
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////// Aftermath Swap ////////////////////////////////
///////////////////////////////////////////////////////////////////////////
export async function executeAftermathSwap(
  router: Router,
  signer: Ed25519Keypair,
  client: SuiClient,
  coinInType: string,
  coinOutType: string,
  assetForwarderAddress: string,
  lossThreshold: string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
    providedFees,
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id: string;
    deposit_id: string;
    forwarder_router_address: string;
    minDestAmount: number;
    providedFees: string;
  }
) {
  // Convert and validate loss threshold
  const maxLossThreshold = Number(lossThreshold);
  if (
    isNaN(maxLossThreshold) ||
    maxLossThreshold <= 0 ||
    maxLossThreshold > 100
  ) {
    throw new Error(
      JSON.stringify({
        message: "Invalid loss threshold configuration",
        maxLossThreshold,
      })
    );
  }

  // Initialize variables
  let currentLossThreshold = 10;
  let currentAmount = BigInt(amount);
  let finalRoute = null;

  // Find suitable route with required output amount
  while (currentLossThreshold <= maxLossThreshold) {
    try {
      const completeRoute = await router.getCompleteTradeRouteGivenAmountIn({
        coinInAmount: currentAmount,
        coinInType,
        coinOutType,
      });

      const coinOutAmount = Number(completeRoute.coinOut.amount);

      if (coinOutAmount <= 0) {
        throw new Error(
          JSON.stringify({
            message: "Invalid coinOutAmount received from route",
            coinOutAmount,
          })
        );
      }

      if (coinOutAmount < minDestAmount) {
        // Calculate adjustment based on provided fees and current threshold
        const adjustment =
          (BigInt(providedFees) * BigInt(currentLossThreshold)) / BigInt(100);
        currentAmount = currentAmount + adjustment;

        console.log(
          JSON.stringify({
            message: "Increasing input amount due to insufficient output",
            currentLossThreshold,
            originalAmount: amount,
            newAmount: currentAmount.toString(),
            adjustment: adjustment.toString(),
            coinOutAmount,
            minDestAmount,
          })
        );

        currentLossThreshold += 10;
        if (currentLossThreshold > maxLossThreshold) {
          throw new Error(
            JSON.stringify({
              message: "Maximum loss threshold reached in AFTERMATH",
              maxLossThreshold,
              finalCoinOutAmount: coinOutAmount,
              minDestAmount,
              finalAmount: currentAmount.toString(),
            })
          );
        }
        continue;
      }

      finalRoute = completeRoute;
      break;
    } catch (error) {
      if (
        currentLossThreshold > maxLossThreshold ||
        !(
          error instanceof Error &&
          error.message.includes("Insufficient coinOutAmount")
        )
      ) {
        console.error(
          JSON.stringify({
            message: "Failed to find suitable route in AFTERMATH",
            error:
              error instanceof Error ? error.message : "Unknown error occurred",
            finalLossThreshold: currentLossThreshold - 10,
          })
        );
        throw error;
      }
    }
  }
  // If no suitable route found
  if (!finalRoute) {
    throw new Error(
      JSON.stringify({
        message: "Could not find suitable route in AFTERMATH after all retries",
        finalAmount: currentAmount.toString(),
        finalLossThreshold: currentLossThreshold - 10,
      })
    );
  }

  try {
    const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
    const af_object_id = "0x" + assetForwarderAddress.slice(66);

    const slippage =
      ((Number(finalRoute.coinOut.amount) - minDestAmount) /
        Number(finalRoute.coinOut.amount)) *
      100;

    const { tx: txb, coinOutId } =
      await router.addTransactionForCompleteTradeRoute({
        tx: new Transaction(),
        completeRoute: finalRoute,
        slippage,
        walletAddress: signer.getPublicKey().toSuiAddress(),
      });

    if (!af_object_id || !coinOutId) {
      throw new Error(
        JSON.stringify({
          message: "Fund relay failed in AFTERMATH due to undefined arguments",
          af_object_id,
          coinOutId,
        })
      );
    }

    txb.moveCall({
      target: `${af_module_address}::asset_forwarder::i_relay`,
      arguments: [
        txb.object(af_object_id),
        txb.object(coinOutId),
        txb.pure.u64(minDestAmount),
        txb.pure(
          bcs.ser("vector<u8>", ethers.getBytes(src_chain_id)).toBytes()
        ),
        txb.pure.u256(deposit_id),
        txb.pure.address(recipient),
        txb.pure.string(forwarder_router_address),
      ],
      typeArguments: [coinOutType],
    });

    const suiReward = 0.015 * 10 ** 9;
    const splittedCoin = txb.splitCoins(txb.gas, [suiReward]);
    txb.transferObjects([splittedCoin], txb.pure.address(recipient));

    const result = await signAndSendTx(client, txb, signer);

    console.log(
      JSON.stringify({
        message: "Fund relayed successfully through AFTERMATH",
        digest: result.digest,
        finalLossThreshold: currentLossThreshold - 10,
        finalAmount: currentAmount.toString(),
      })
    );
    return;
  } catch (error) {
    const formattedError = {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
    console.error(
      JSON.stringify({
        message: "Transaction execution failed in AFTERMATH",
        error: formattedError.error,
        finalLossThreshold: currentLossThreshold - 10,
        finalAmount: currentAmount.toString(),
      })
    );
    throw new Error(formattedError.error);
  }
}


/////////////////////////////////////////////////////////////////////////////
//////////////////////////// Turbos Swap ///////////////////////////////////
///////////////////////////////////////////////////////////////////////////
async function executeTurbosSwap(
  signer: Ed25519Keypair,
  client: SuiClient,
  sdk: TurbosSdk,
  coinInType: string,
  coinOutType: string,
  apiUrl: string,
  assetForwarderAddress: string,
  lossThreshold: string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
    providedFees
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id: string;
    deposit_id: string;
    forwarder_router_address: string;
    minDestAmount: number;
    providedFees: string;
  }
) {
    // Convert and validate loss threshold
    const maxLossThreshold = Number(lossThreshold);
    if (isNaN(maxLossThreshold) || maxLossThreshold <= 0 || maxLossThreshold > 100) {
        throw new Error(JSON.stringify({
            message: "Invalid loss threshold configuration",
            maxLossThreshold
        }));
    }

    // Initialize variables
    let currentLossThreshold = 10;
    let currentAmount = BigInt(amount);
    let finalQuote = null;

    // Find suitable quote with required output amount
    while (currentLossThreshold <= maxLossThreshold) {
        try {
            const quoteResult = await getTurbosQuote(
                signer,
                sdk,
                coinInType,
                coinOutType,
                apiUrl,
                currentAmount.toString()
            );

            const { coinOutAmount, bestPoolId, result, a2b } = quoteResult;

            if (coinOutAmount <= 0) {
                throw new Error(
                    JSON.stringify({
                        message: "Invalid coinOutAmount received from route",
                        coinOutAmount,
                    })
                );
            }

            if (coinOutAmount < minDestAmount) {
                // Calculate adjustment based on provided fees and current threshold
                const adjustment = (BigInt(providedFees) * BigInt(currentLossThreshold)) / BigInt(100);
                currentAmount = currentAmount + adjustment;

                console.log(
                    JSON.stringify({
                        message: "Increasing input amount due to insufficient output in TURBOS",
                        currentLossThreshold,
                        originalAmount: amount,
                        newAmount: currentAmount.toString(),
                        adjustment: adjustment.toString(),
                        coinOutAmount,
                        minDestAmount
                    })
                );

                currentLossThreshold += 10;
                if (currentLossThreshold > maxLossThreshold) {
                    throw new Error(
                        JSON.stringify({
                            message: "Maximum loss threshold reached in TURBOS",
                            maxLossThreshold,
                            finalCoinOutAmount: coinOutAmount,
                            minDestAmount,
                            finalAmount: currentAmount.toString()
                        })
                    );
                }
                continue;
            }

            finalQuote = quoteResult;
            break;

        } catch (error) {
            if (currentLossThreshold > maxLossThreshold || 
                !(error instanceof Error && error.message.includes("Insufficient coinOutAmount"))) {
                console.error(
                    JSON.stringify({ 
                        message: "Failed to find suitable quote in TURBOS",
                        error: error instanceof Error ? error.message : "Unknown error occurred",
                        finalLossThreshold: currentLossThreshold - 10
                    })
                );
                throw error;
            }
        }
    }

    // If no suitable quote found
    if (!finalQuote) {
        throw new Error(
            JSON.stringify({
                message: "Could not find suitable quote in TURBOS after all retries",
                finalAmount: currentAmount.toString(),
                finalLossThreshold: currentLossThreshold - 10
            })
        );
    }

    try {
        const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
        const af_object_id = "0x" + assetForwarderAddress.slice(66);

        const { coinOutAmount, bestPoolId, result, a2b } = finalQuote;
        const nextTickIndex = sdk.math.bitsToNumber(result.tick_current_index.bits);
        const slippage = ((coinOutAmount - minDestAmount) / coinOutAmount) * 100;

        const swapOptions: Trade.SwapWithReturnOptions = {
            poolId: bestPoolId,
            coinType: coinInType,
            amountA: a2b ? currentAmount.toString() : String(coinOutAmount),
            amountB: a2b ? String(coinOutAmount) : currentAmount.toString(),
            swapAmount: currentAmount.toString(),
            nextTickIndex,
            slippage: String(slippage),
            amountSpecifiedIsInput: true,
            a2b: a2b,
            address: signer.getPublicKey().toSuiAddress(),
        };

        const { txb, coinVecA, coinVecB } = await sdk.trade.swapWithReturn(swapOptions);

        let coinOutId;
        if (a2b) {
            coinOutId = coinVecB;
            if (coinVecA) {
                txb.transferObjects([coinVecA], txb.pure.address(recipient));
            }
        } else {
            coinOutId = coinVecA;
            if (coinVecB) {
                txb.transferObjects([coinVecB], txb.pure.address(recipient));
            }
        }

        if (!coinOutId) {
            throw new Error(
                JSON.stringify({
                    message: "Failed to retrieve coinOutId from TURBOS"
                })
            );
        }

        if (!af_object_id || !coinOutId) {
            throw new Error(
                JSON.stringify({
                    message: "Fund relay failed due to undefined arguments",
                    af_object_id,
                    coinOutId,
                })
            );
        }

        txb.moveCall({
            target: `${af_module_address}::asset_forwarder::i_relay`,
            arguments: [
                txb.object(af_object_id),
                txb.object(coinOutId),
                txb.pure.u64(minDestAmount),
                txb.pure(bcs.ser("vector<u8>", ethers.getBytes(src_chain_id)).toBytes()),
                txb.pure.u256(deposit_id),
                txb.pure.address(recipient),
                txb.pure.string(forwarder_router_address),
            ],
            typeArguments: [coinOutType],
        });

        const suiReward = 0.015 * 10 ** 9;
        const splittedCoin = txb.splitCoins(txb.gas, [suiReward]);
        txb.transferObjects([splittedCoin], txb.pure.address(recipient));

        const txResult = await signAndSendTx(client, txb, signer);

        console.log(
            JSON.stringify({
                message: "Fund relayed successfully through TURBOS",
                digest: txResult.digest,
                finalLossThreshold: currentLossThreshold - 10,
                finalAmount: currentAmount.toString()
            })
        );
        return;

    } catch (error) {
        const formattedError = {
            error: error instanceof Error ? error.message : "Unknown error occurred",
        };
        console.error(
            JSON.stringify({
                message: "Transaction execution failed in TURBOS",
                error: formattedError.error,
                finalLossThreshold: currentLossThreshold - 10,
                finalAmount: currentAmount.toString()
            })
        );
        throw new Error(formattedError.error);
    }
}

async function getTurbosQuote(
  signer: Ed25519Keypair,
  sdk: TurbosSdk,
  coinInType: string,
  coinOutType: string,
  apiUrl: string,
  amount: string | number | bigint
): Promise<{coinOutAmount:number; bestPoolId: string; result: Trade.ComputedSwapResult; a2b: boolean }> {
  
  const { bestPoolId, a2b } = await getBestPoolIdAndDirection(apiUrl, coinInType, coinOutType);

  const tradeOptions: Trade.ComputeSwapResultOptionsV2 = {
    pools: [
      {
        pool: bestPoolId,
        a2b: a2b,
        amountSpecified: amount as number,
      },
    ],
    address: signer.getPublicKey().toSuiAddress(),
    amountSpecifiedIsInput: true,
  };

  const tradeResult = await sdk.trade.computeSwapResultV2(tradeOptions);
  
  if (tradeResult.length === 0) {
    throw new Error(
      JSON.stringify({
        message: "No trade results found from TURBOS computeSwapResultV2",
      })
    );
  }

  const result = tradeResult[0];

  const coinOutAmount = result.a_to_b ? Number(result.amount_b) : Number(result.amount_a)

  return {coinOutAmount,bestPoolId,result,a2b}
  
}

async function getBestPoolIdAndDirection(
  apiUrl: string,
  tokenA: string,
  tokenB: string
): Promise<{ bestPoolId: string; a2b: boolean }> {

  const suiTokenType = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const overrideSuiTokenType = "0x2::sui::SUI";

  if (tokenA === suiTokenType) {
    tokenA = overrideSuiTokenType;
  }

  if (tokenB === suiTokenType) {
    tokenB = overrideSuiTokenType;
  }

  // Fetch pools involving Token A
  const response = await axios.get(`${apiUrl}&symbol=${tokenA}`);
  const data = response.data;

  // Validate response
  if (data.code !== 0 || !data.data?.list) {
    throw new Error(
      JSON.stringify({
        message: "Invalid response from TURBOS API",
      })
    );
  }

  // Filter pools to include only those involving Token B
  const filteredPools = data.data.list.filter(
    (pool: any) => pool.coin_type_a === tokenB || pool.coin_type_b === tokenB
  );

  // Check if any pools match the criteria
  if (filteredPools.length === 0) {
    throw new Error(
      JSON.stringify({
        message: "No pools found in TURBOS for given tokens",
      })
    );
  }

  // Sort pools by liquidity in descending order
  const sortedPools = filteredPools.sort((a: any, b: any) =>
    parseFloat(b.liquidity) - parseFloat(a.liquidity)
  );

  // Get the pool with the highest liquidity
  const bestPool = sortedPools[0];

  // Determine trade direction (a2b)
  const a2b = tokenA === bestPool.coin_type_a && tokenB === bestPool.coin_type_b;

  // Return the pool ID and direction
  return { bestPoolId: bestPool.pool_id, a2b };
  
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////// FlowX Swap ///////////////////////////////////
///////////////////////////////////////////////////////////////////////////
async function executeFlowXSwap(  
  signer: Ed25519Keypair,
  client: SuiClient,
  quoter: AggregatorQuoter,
  coinInType: string,
  coinOutType: string,
  assetForwarderAddress: string,
  lossThreshold: string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
    providedFees,
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id: string;
    deposit_id: string;
    forwarder_router_address: string;
    minDestAmount: number;
    providedFees: string;
  }
) {
    // Convert and validate loss threshold
    const maxLossThreshold = Number(lossThreshold);
    if (isNaN(maxLossThreshold) || maxLossThreshold <= 0 || maxLossThreshold > 100) {
        throw new Error(JSON.stringify({
            message: "Invalid loss threshold configuration",
            maxLossThreshold
        }));
    }

    // Initialize variables
    let currentLossThreshold = 10;
    let currentAmount = BigInt(amount);
    let finalRoute = null;

    // Find suitable quote with required output amount
    while (currentLossThreshold <= maxLossThreshold) {
        try {
            const routes = await quoter.getRoutes({
                tokenIn: coinInType,
                tokenOut: coinOutType,
                amountIn: currentAmount.toString(),
            });

            const coinOutAmount = Number(routes.amountOut);

            if (coinOutAmount <= 0) {
                throw new Error(
                    JSON.stringify({
                        message: "Invalid coinOutAmount received from route",
                        coinOutAmount,
                    })
                );
            }

            if (coinOutAmount < minDestAmount) {
                // Calculate adjustment based on provided fees and current threshold
                const adjustment = (BigInt(providedFees) * BigInt(currentLossThreshold)) / BigInt(100);
                currentAmount = currentAmount + adjustment;

                console.log(
                    JSON.stringify({
                        message: "Increasing input amount due to insufficient output in FlowX",
                        currentLossThreshold,
                        originalAmount: amount,
                        newAmount: currentAmount.toString(),
                        adjustment: adjustment.toString(),
                        coinOutAmount,
                        minDestAmount
                    })
                );

                currentLossThreshold += 10;
                if (currentLossThreshold > maxLossThreshold) {
                    throw new Error(
                        JSON.stringify({
                            message: "Maximum loss threshold reached in FlowX",
                            maxLossThreshold,
                            finalCoinOutAmount: coinOutAmount,
                            minDestAmount,
                            finalAmount: currentAmount.toString()
                        })
                    );
                }
                continue;
            }

            finalRoute = routes;
            break;

        } catch (error) {
            if (currentLossThreshold > maxLossThreshold || 
                !(error instanceof Error && error.message.includes("Insufficient coinOutAmount"))) {
                console.error(
                    JSON.stringify({ 
                        message: "Failed to find suitable quote in FlowX",
                        error: error instanceof Error ? error.message : "Unknown error occurred",
                        finalLossThreshold: currentLossThreshold - 10
                    })
                );
                throw error;
            }
        }
    }

    // If no suitable route found
    if (!finalRoute) {
        throw new Error(
            JSON.stringify({
                message: "Could not find suitable quote in FlowX after all retries",
                finalAmount: currentAmount.toString(),
                finalLossThreshold: currentLossThreshold - 10
            })
        );
    }

    try {
        const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
        const af_object_id = "0x" + assetForwarderAddress.slice(66);

        const coinOutAmount = Number(finalRoute.amountOut);
        const slippage = (((coinOutAmount - minDestAmount) / coinOutAmount) * 100) * 10000;

        const tradeBuilder = new TradeBuilder("mainnet", finalRoute.routes);
        const trade = tradeBuilder
            .sender(signer.getPublicKey().toSuiAddress())
            .amountIn(currentAmount.toString())
            .amountOut(finalRoute.amountOut)
            .slippage(Number(slippage.toFixed(0)))
            .deadline(Date.now() + 3600000)
            .build();

        const txb = new Transaction();
        const coinOutId = await trade.swap({ tx: txb, client: client });

        if (!af_object_id || !coinOutId) {
            throw new Error(
                JSON.stringify({
                    message: "Fund relay failed due to undefined arguments",
                    af_object_id,
                    coinOutId,
                })
            );
        }

        txb.moveCall({
            target: `${af_module_address}::asset_forwarder::i_relay`,
            arguments: [
                txb.object(af_object_id),
                txb.object(coinOutId),
                txb.pure.u64(minDestAmount),
                txb.pure(bcs.ser("vector<u8>", ethers.getBytes(src_chain_id)).toBytes()),
                txb.pure.u256(deposit_id),
                txb.pure.address(recipient),
                txb.pure.string(forwarder_router_address),
            ],
            typeArguments: [coinOutType],
        });

        const suiReward = 0.015 * 10 ** 9;
        const splittedCoin = txb.splitCoins(txb.gas, [suiReward]);
        txb.transferObjects([splittedCoin], txb.pure.address(recipient));

        const txResult = await signAndSendTx(client, txb, signer);

        console.log(
            JSON.stringify({
                message: "Fund relayed successfully through FlowX",
                digest: txResult.digest,
                finalLossThreshold: currentLossThreshold - 10,
                finalAmount: currentAmount.toString()
            })
        );
        return;

    } catch (error) {
        const formattedError = {
            error: error instanceof Error ? error.message : "Unknown error occurred",
        };
        console.error(
            JSON.stringify({
                message: "Transaction execution failed in FlowX",
                error: formattedError.error,
                finalLossThreshold: currentLossThreshold - 10,
                finalAmount: currentAmount.toString()
            })
        );
        throw new Error(formattedError.error);
    }
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////// MAIN //////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////
async function main() {
  const [
    privateKey,
    partnerId,
    coinInType,
    coinOutType,
    amount,
    recipient,
    srcChainId,
    depositId,
    forwarderRouterAddress,
    minDestAmount,
    assetForwarderAddress,
    lossThreshold,
    providedFees
  ] = process.argv.slice(2);

  const formatHex = (value: string): string => (value.startsWith("0x") ? value : `0x${value}`);

  // Formatted inputs
  const privateKeyHex = formatHex(privateKey);
  const _coinInType = formatHex(coinInType);
  const _coinOutType = formatHex(coinOutType);
  const _recipient = formatHex(recipient);
  const _srcChainId = formatHex(srcChainId);

  // Initialization
  const signer = Ed25519Keypair.fromSecretKey(Uint8Array.from(ethers.getBytes(privateKeyHex)));
  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const aftermathSdk = new Aftermath("MAINNET");
  const turbosSdk = new TurbosSdk(Network.mainnet);
  const turbosApiUrl = "https://api.turbos.finance/pools/v2?page=1&pageSize=1000&orderBy=liquidity";
  const quoter = new AggregatorQuoter('mainnet');

  // DEX Registry
  const dexRegistry: Record<
    number,
    { name: string; execute: () => Promise<void>; getQuote: () => Promise<any> }
  > = {
    8000: {
      name: "Aftermath",
      execute: async () =>
        executeAftermathSwap(
          aftermathSdk.Router(),
          signer,
          client,
          _coinInType,
          _coinOutType,
          assetForwarderAddress,
          lossThreshold,
          {
            amount,
            recipient: _recipient,
            src_chain_id: _srcChainId,
            deposit_id: depositId,
            forwarder_router_address: forwarderRouterAddress,
            minDestAmount: Number(minDestAmount),
            providedFees,
          }
        ),
      getQuote: async () =>
        aftermathSdk.Router().getCompleteTradeRouteGivenAmountIn({
          coinInAmount: BigInt(amount),
          coinInType: _coinInType,
          coinOutType: _coinOutType,
        }),
    },
    8001: {
      name: "Turbos",
      execute: async () =>
        executeTurbosSwap(
          signer,
          client,
          turbosSdk,
          _coinInType,
          _coinOutType,
          turbosApiUrl,
          assetForwarderAddress,
          lossThreshold,
          {
            amount,
            recipient: _recipient,
            src_chain_id: _srcChainId,
            deposit_id: depositId,
            forwarder_router_address: forwarderRouterAddress,
            minDestAmount: Number(minDestAmount),
            providedFees,
          }
        ),
      getQuote: async () =>
        getTurbosQuote(
          signer,
          turbosSdk,
          _coinInType,
          _coinOutType,
          turbosApiUrl,
          amount
        ),
    },
    8002: {
      name: "FlowX",
      execute: async () =>
        executeFlowXSwap(
          signer,
          client,
          quoter,
          _coinInType,
          _coinOutType,
          assetForwarderAddress,
          lossThreshold,
          {
            amount,
            recipient: _recipient,
            src_chain_id: _srcChainId,
            deposit_id: depositId,
            forwarder_router_address: forwarderRouterAddress,
            minDestAmount: Number(minDestAmount),
            providedFees,
          }
        ),
      getQuote: async () =>
        quoter.getRoutes({
          tokenIn: coinInType,
          tokenOut: coinOutType,
          amountIn: amount as string,
        }),
    },
  };

  try {
    const partnerIdNumber = parseInt(partnerId, 10);
    // Determine DEX execution based on partnerId
    if (partnerId && dexRegistry[partnerIdNumber]) {
      const selectedDex = dexRegistry[partnerIdNumber];
      try {
        await selectedDex.execute();
      } catch (primaryError) {
        //Handle fallback to other DEXes
        const fallbackDexes = Object.values(dexRegistry).filter((dex) => dex !== selectedDex);
        var fallbackErrorMessage
        for (const fallbackDex of fallbackDexes) {
          try {
            await fallbackDex.execute();
            return;
          } catch (fallbackError) {
            fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : `Unknown error: ${String(fallbackError)}`;
          }
        }
        const primaryErrorMessage = primaryError instanceof Error ? primaryError.message : `Unknown error: ${String(primaryError)}`;

        console.log(
          JSON.stringify({ 
              message: "All DEX swaps failed in fallback in PartnerId flow ", 
              error : primaryErrorMessage + "" + fallbackErrorMessage
          })
        );

        process.exit(1);
      }
    } else {
      // Handle case for partnerId === 0 (generalized flow)
      const quotes = await Promise.allSettled(
        Object.values(dexRegistry).map((dex) => dex.getQuote())
      );

      // Map quotes to DEX and handle specific `coinOutAmount` structures
      const dexQuotes = quotes.map((quote, index) => {
        const dex = Object.values(dexRegistry)[index];
        let coinOutAmount = BigInt(0);
        if (quote.status === "fulfilled") {
          if (dex.name === "Aftermath") {
            coinOutAmount = BigInt(quote.value.coinOut.amount || 0);
          } else if (dex.name === "Turbos") {
            coinOutAmount = BigInt(quote.value.coinOutAmount || 0);
          } else if (dex.name === "FlowX") {
            coinOutAmount = BigInt(quote.value.amountOut || 0);
          }
        }
        return { dex, quote: coinOutAmount };
      });

      // Sort DEXes by quotes
      dexQuotes.sort((a, b) => Number(b.quote - a.quote));

      var errorMessage
      // Attempt swaps in descending order of quotes
      for (const { dex, quote } of dexQuotes) {
        if (quote > 0) {
          try {
            await dex.execute();
            return;
          } catch (error) {
            errorMessage = error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
          }
        }
      }
   
      console.log(
        JSON.stringify({ 
            message: "All DEX swaps failed in No-PartnerId flow ", 
            error : errorMessage
        })
      );
      process.exit(1);
    }
  } catch (primaryError) {
    const formattedError = {
      error: primaryError instanceof Error ? primaryError.message : "Unknown error occurred",
    };    
    console.log(
      JSON.stringify({ 
          message: "Fund relay failed ", 
          error : formattedError.error
      })
    );
    process.exit(1);
  }
}

main();
