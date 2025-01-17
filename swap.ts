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
  assetForwarderAddress : string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id:string;
    deposit_id:string;
    forwarder_router_address:string;
    minDestAmount:number;
  }
) {

  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
  const af_object_id = "0x" + assetForwarderAddress.slice(66);

  while (retryCount <= MAX_RETRIES) {
    try {

        const completeRoute = await router.getCompleteTradeRouteGivenAmountIn({
            coinInAmount: BigInt(amount),
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
            throw new Error(
              JSON.stringify({
                message: "Insufficient coinOutAmount",
                coinOutAmount,
                minDestAmount,
                retryCount,
              })
            );
        }

        const slippage = ((coinOutAmount - minDestAmount) / coinOutAmount) * 100;

        const { tx: txb, coinOutId } = await router.addTransactionForCompleteTradeRoute({
            tx: new Transaction(),
            completeRoute,
            slippage,
            walletAddress: signer.getPublicKey().toSuiAddress(),
        });

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

        const splittedCoin = txb.splitCoins(txb.gas,[suiReward])

        // Transfer the coin to the recipient
        txb.transferObjects([splittedCoin], txb.pure.address(recipient));
        
        const result = await signAndSendTx(client, txb, signer);
    
        console.log(
            JSON.stringify({ message: "Fund relayed successfully through AFTERMATH :", digest: result.digest })
        );
        return;
    } catch (error) {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          // Log failure after all retries
          const formattedError = {
            error: error instanceof Error ? error.message : "Unknown error occurred",
          };
          // Log failure after all retries
          console.log(
              JSON.stringify({ 
                  message: "Fund relay in AFTERMATH failed after maximum retries", 
                  error : formattedError.error
              })
          );
          throw new Error(formattedError.error);
        }
      }
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
  assetForwarderAddress : string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id:string;
    deposit_id:string;
    forwarder_router_address:string;
    minDestAmount:number;
  }
) {

  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
  const af_object_id = "0x" + assetForwarderAddress.slice(66);

  while (retryCount <= MAX_RETRIES) {
    try {

      const {coinOutAmount,bestPoolId,result,a2b} = await getTurbosQuote(signer,sdk,coinInType,coinOutType,apiUrl,amount);

      // Check for invalid coinOutAmount
      if (coinOutAmount <= 0) {
        throw new Error(
          JSON.stringify({
            message: "Invalid coinOutAmount received from route",
            coinOutAmount,
          })
        );
      }

      // Check if coinOutAmount meets minDestAmount
      if (coinOutAmount < minDestAmount) {
        throw new Error(
          JSON.stringify({
            message: "Insufficient coinOutAmount",
            coinOutAmount,
            minDestAmount,
          })
        );
      }

      const nextTickIndex = sdk.math.bitsToNumber(result.tick_current_index.bits);

      const slippage = ((coinOutAmount - minDestAmount) / coinOutAmount) * 100;

      const swapOptions: Trade.SwapWithReturnOptions = {
        poolId: bestPoolId,
        coinType: coinInType,
        amountA: a2b ? String(amount) : String(coinOutAmount), // Input token amount
        amountB: a2b ? String(coinOutAmount) : String(amount), // Output token amount
        swapAmount: String(amount), // Always the input amount
        nextTickIndex,
        slippage: String(slippage),
        amountSpecifiedIsInput: true,
        a2b: a2b,
        address: signer.getPublicKey().toSuiAddress(),
      };

      const { txb, coinVecA, coinVecB } = await sdk.trade.swapWithReturn(swapOptions);

      // Use the coinOutId from the appropriate vector (coinVecA or coinVecB)
      let coinOutId 
      if(a2b){
        coinOutId = coinVecB
        if(coinVecA){
          txb.transferObjects([coinVecA],txb.pure.address(recipient))
        }
      } else {
        coinOutId = coinVecA
        if(coinVecB){
          txb.transferObjects([coinVecB],txb.pure.address(recipient))
        }
      }

      if (!coinOutId) {
        throw new Error(
          JSON.stringify({
              message: "Failed to retrieve coinOutId from TURBOS",
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

      const splittedCoin = txb.splitCoins(txb.gas,[suiReward])

      // Transfer the coin to the recipient
      txb.transferObjects([splittedCoin], txb.pure.address(recipient));

      const txResult = await signAndSendTx(client, txb, signer);

      console.log(
        JSON.stringify({ message: "Fund relayed successfully through TURBOS :", digest: txResult.digest })
      );

      return;

    } catch (error) {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
          // Log failure after all retries
          const formattedError = {
            error: error instanceof Error ? error.message : "Unknown error occurred",
          };
          // Log failure after all retries
          console.log(
              JSON.stringify({ 
                  message: "Fund relay in TURBOS failed after maximum retries", 
                  error : formattedError.error
              })
          );
          throw new Error(formattedError.error);
      }
    }
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
  assetForwarderAddress : string,
  {
    amount,
    recipient,
    src_chain_id,
    deposit_id,
    forwarder_router_address,
    minDestAmount,
  }: {
    amount: string | number | bigint;
    recipient: string;
    src_chain_id:string;
    deposit_id:string;
    forwarder_router_address:string;
    minDestAmount:number;
  }
) {

  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  const af_module_address = "0x" + assetForwarderAddress.slice(2, 66);
  const af_object_id = "0x" + assetForwarderAddress.slice(66);

  while (retryCount <= MAX_RETRIES) {
    try {
      const routes = await quoter.getRoutes({
        tokenIn: coinInType,
        tokenOut: coinOutType,
        amountIn: amount as string,
      })

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
          throw new Error(
            JSON.stringify({
              message: "Insufficient coinOutAmount",
              coinOutAmount,
              minDestAmount,
              retryCount,
            })
          );
      }

      const slippage = (((coinOutAmount - minDestAmount) / coinOutAmount) * 100) * 10000;

      const tradeBuilder = new TradeBuilder("mainnet", routes.routes); 

      const trade = tradeBuilder
                      .sender(signer.getPublicKey().toSuiAddress())
                      .amountIn(amount as string)
                      .amountOut(routes.amountOut)
                      .slippage(Number(slippage.toFixed(0))) //  1% = 10000
                      .deadline(Date.now() +3600000) // 1 hour from now
                      .build();
      
      const txb = new Transaction()

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

      const splittedCoin = txb.splitCoins(txb.gas,[suiReward])

      // Transfer the coin to the recipient
      txb.transferObjects([splittedCoin], txb.pure.address(recipient));

      const txResult = await signAndSendTx(client, txb, signer);

      console.log(
        JSON.stringify({ message: "Fund relayed successfully through FLOW X : ", digest: txResult.digest })
      );

      return;

      } catch (error) {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          // Log failure after all retries
          const formattedError = {
            error: error instanceof Error ? error.message : "Unknown error occurred",
          };
          // Log failure after all retries
          console.log(
              JSON.stringify({ 
                  message: "Fund relay in FlowX failed after maximum retries", 
                  error : formattedError.error
              })
          );
          throw new Error(formattedError.error);
      }
    }
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
  const dexRegistry: Record<number, { name: string; execute: () => Promise<void>; getQuote: () => Promise<any> }> = {
    8001: {
      name: "Aftermath",
      execute: async () =>
        executeAftermathSwap(aftermathSdk.Router(),signer,client,_coinInType,_coinOutType,assetForwarderAddress,
          {
            amount,
            recipient: _recipient,
            src_chain_id: _srcChainId,
            deposit_id: depositId,
            forwarder_router_address: forwarderRouterAddress,
            minDestAmount: Number(minDestAmount),
          }
        ),
      getQuote: async () =>
        aftermathSdk.Router().getCompleteTradeRouteGivenAmountIn({
          coinInAmount: BigInt(amount),
          coinInType: _coinInType,
          coinOutType: _coinOutType,
        }),
    },
    8000: {
      name: "Turbos",
      execute: async () =>
        executeTurbosSwap(signer, client, turbosSdk, _coinInType, _coinOutType, turbosApiUrl, assetForwarderAddress, {
          amount,
          recipient: _recipient,
          src_chain_id: _srcChainId,
          deposit_id: depositId,
          forwarder_router_address: forwarderRouterAddress,
          minDestAmount: Number(minDestAmount),
        }),
      getQuote: async () =>
        getTurbosQuote(signer, turbosSdk, _coinInType, _coinOutType, turbosApiUrl, amount),
    },
    8002 : {
      name: "FlowX",
      execute: async () =>
        executeFlowXSwap(signer, client, quoter, _coinInType, _coinOutType, assetForwarderAddress, {
          amount,
          recipient: _recipient,
          src_chain_id: _srcChainId,
          deposit_id: depositId,
          forwarder_router_address: forwarderRouterAddress,
          minDestAmount: Number(minDestAmount),
        }),
      getQuote: async () => 
        quoter.getRoutes({tokenIn: coinInType,tokenOut: coinOutType,amountIn: amount as string}),    
    }
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
