import { Transaction } from "@mysten/sui/transactions";
import { ethers } from "ethers";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";


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


// Exporting the async function receive_message
export async function receive_message(
    signer: Ed25519Keypair,
    client: SuiClient,
    message_transmitter_id : string,
    message_transmitter_state : string,
    token_messenger_minter_id : string,
    token_messenger_minter_state : string,
    treasury : string,
    usdc : string, 
    message : string,
    attestation : string,
) {

    const MAX_RETRIES = 3; // Maximum number of retries
    let retryCount = 0;
    
    while (retryCount <= MAX_RETRIES) {

        try {
            const receiveMessageTx = new Transaction();

            if (!message_transmitter_id || !message_transmitter_state || !token_messenger_minter_id || !token_messenger_minter_state || !treasury || !usdc)  {
                throw new Error(
                JSON.stringify({
                    message: "Fund relay failed due to undefined arguments",
                })
                );
            }

            const [receipt] = receiveMessageTx.moveCall({
                target: `${message_transmitter_id}::receive_message::receive_message`,
                arguments: [
                  receiveMessageTx.pure.vector(
                    "u8",
                    Buffer.from(message.replace("0x", ""), "hex")
                  ), // message as byte array
                  receiveMessageTx.pure.vector(
                    "u8",
                    Buffer.from(attestation.replace("0x", ""), "hex")
                  ), // attestation as byte array
                  receiveMessageTx.object(message_transmitter_state), // message_transmitter state
                ],
            });

            const [stampReceiptTicketWithBurnMessage] = receiveMessageTx.moveCall({
                target: `${token_messenger_minter_id}::handle_receive_message::handle_receive_message`,
                arguments: [
                  receipt, // Receipt object returned from receive_message call
                  receiveMessageTx.object(token_messenger_minter_state), // token_messenger_minter state
                  receiveMessageTx.object("0x403"), // deny list, fixed address
                  receiveMessageTx.object(treasury), // usdc treasury object Treasury<T>
                ],
                typeArguments: [`${usdc}::usdc::USDC`],
            });

            const [stampReceiptTicket, burnMessage] = receiveMessageTx.moveCall({
                target: `${token_messenger_minter_id}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message`,
                arguments: [
                  stampReceiptTicketWithBurnMessage, // Receipt object returned from receive_message call
                ],
                typeArguments: [],
            });
            
            const [stampedReceipt] = receiveMessageTx.moveCall({
                target: `${message_transmitter_id}::receive_message::stamp_receipt`,
                arguments: [
                  stampReceiptTicket,
                  receiveMessageTx.object(message_transmitter_state), // token_messenger_minter state
                ],
                typeArguments: [
                  `${token_messenger_minter_id}::message_transmitter_authenticator::MessageTransmitterAuthenticator`,
                ],
            });

            receiveMessageTx.moveCall({
                target: `${message_transmitter_id}::receive_message::complete_receive_message`,
                arguments: [
                  stampedReceipt,
                  receiveMessageTx.object(message_transmitter_state), // message_transmitter state
                ],
            });

            const receiveMessageOutput = await signAndSendTx(
                client,
                receiveMessageTx,
                signer
            );
            // Log success and return digest
            console.log(
                JSON.stringify({ message: "Fund relayed successfully", digest: receiveMessageOutput.digest })
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
        message_transmitter_id,
        message_transmitter_state,
        token_messenger_minter_id,
        token_messenger_minter_state,
        treasury,
        usdc,
        message,
        attestation,
      ] = process.argv.slice(2);
    
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
    await receive_message(
        signer,
        client,
        message_transmitter_id.startsWith("0x") ? message_transmitter_id : `0x${message_transmitter_id}`,
        message_transmitter_state.startsWith("0x") ? message_transmitter_state : `0x${message_transmitter_state}`,
        token_messenger_minter_id.startsWith("0x") ? token_messenger_minter_id : `0x${token_messenger_minter_id}`,
        token_messenger_minter_state.startsWith("0x") ? token_messenger_minter_state : `0x${token_messenger_minter_state}`,
        treasury.startsWith("0x") ? treasury : `0x${treasury}`,
        usdc.startsWith("0x") ? usdc : `0x${usdc}`, 
        message,
        attestation
    )
}

main()
