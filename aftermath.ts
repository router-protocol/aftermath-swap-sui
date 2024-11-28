import { Aftermath, Router } from "aftermath-ts-sdk";
import { ethers } from "ethers";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { bech32 } from "bech32";

import { BCS, getSuiMoveConfig } from "@mysten/bcs";
const bcs = new BCS(getSuiMoveConfig());

export function bech32PrivateKeyToHex(pk: string): string | undefined {
  try {
    const decodedResult = bech32.decode(pk);
    const decodedAddress = bech32.fromWords(decodedResult.words);
    const hexAddress = Buffer.from(decodedAddress).toString("hex");
    return "0x" + hexAddress.slice(2);
  } catch (error) {
    console.error("Error decoding Bech32 address:", error);
  }
}

export async function signAndSendTx(
  client: SuiClient,
  txb: Transaction | Uint8Array,
  signer: Ed25519Keypair
) {
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

export async function swap_and_i_relay(
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

    const MAX_RETRIES = 10; // Maximum number of retries
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
        
            // Log success and return digest
            console.log(
                JSON.stringify({ message: "Fund relayed successfully", digest: result.digest })
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
                        message: "Fund relay failed after maximum retries", 
                        error : formattedError.error
                    })
                );
            process.exit(1);
          }
      }
    }
}

async function main() {
    const [
        privateKey,
        coinInType,
        coinOutType,
        amount,
        recipient,
        srcChainId,
        depositId,
        forwarder_router_address,
        minDestAmount,
        assetForwarderAddress,
      ] = process.argv.slice(2);
    
    const afSdk = new Aftermath("MAINNET"); // "MAINNET" | "TESTNET" | "DEVNET"
    const router = afSdk.Router();
    const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

    const privateKeyHex = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    var signer 
    if (privateKeyHex !== undefined) {
        signer = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(
            ethers.getBytes(privateKeyHex)
        )
        );
    } else {
        console.error("Failed to get private key hex");
        // Handle the error case here, maybe throw an error or return early
    }
if (signer)
    await swap_and_i_relay(
        router,
        signer,
        client,
        coinInType.startsWith("0x") ? coinInType : `0x${coinInType}`, // in //destToken from token mapping 
        coinOutType.startsWith("0x") ? coinOutType : `0x${coinOutType}`, // out //already assigned dest token
        assetForwarderAddress,
        {
        amount: amount, // amount In = srcAmount - fee ->(should be in decimals acc to dest chain)
        recipient: recipient.startsWith("0x") ? recipient : `0x${recipient}`,
        src_chain_id: srcChainId.startsWith("0x") ? srcChainId : `0x${srcChainId}`,
        deposit_id: depositId,
        forwarder_router_address:forwarder_router_address,
        minDestAmount:Number(minDestAmount),
    }
  );
};


    main()
