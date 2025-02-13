import { Aptos, AptosConfig, Network, OrderByValue } from "@aptos-labs/ts-sdk"


async function fetchContractEvents(
    client: Aptos,
    toTransactionVersion: string,
    eventTypes: string[], // Accept an array of event types
) {
    const MAX_RETRIES = 5;
    let retryCount = 0;
    const limit = 100;
    let allEvents: any[] = [];

    while (retryCount <= MAX_RETRIES) {
        try {
            // **Parallel Fetching of all Event Types**
            const eventPromises = eventTypes.map(async (eventType) => {
                let offset = 0;
                let eventList: any[] = [];

                while (true) {
                    const options = {
                        limit,
                        offset,
                        orderBy: [{ transaction_version: "desc" as OrderByValue }], // Fetch latest events first
                    };

                    const events = await client.getModuleEventsByEventType({
                        eventType: eventType as `${string}::${string}::${string}`,
                        options,
                    });

                    if (events.length === 0) {
                        break; // No more events
                    }

                    eventList.push(...events);
                    offset += events.length; // Update offset

                    // **Break if last event version is older than `toTransactionVersion`**
                    const lastEventVersion = parseInt(events[events.length - 1].transaction_version);
                    if (lastEventVersion < Number(toTransactionVersion)) {
                        break;
                    }
                }

                return eventList;
            });

            // **Wait for all parallel event fetches to complete**
            const results = await Promise.all(eventPromises);

            // **Merge all fetched events**
            allEvents = results.flat();

            // **Filter to include only events >= `toTransactionVersion`**
            const filteredEvents = allEvents.filter(event => parseInt(event.transaction_version) >= Number(toTransactionVersion));

            // **Sort events in ASCENDING order**
            filteredEvents.sort((a, b) => parseInt(a.transaction_version) - parseInt(b.transaction_version));

            // **Fetch transaction hash for each event**
            const enrichedEvents = await Promise.all(filteredEvents.map(async (event) => {
                try {
                    const txData = await client.getTransactionByVersion({ ledgerVersion: Number(event.transaction_version) });
                    
                    var gasUsed,gasPrice,timestamp

                    if (txData.type === "user_transaction") {
                        gasUsed = txData.gas_used;
                        gasPrice = txData.gas_unit_price;
                        timestamp = txData.timestamp;
                    } 

                    return {
                        ...event,
                        txn_hash: txData.hash,
                        gas_used: gasUsed,
                        gas_unit_price: gasPrice,
                        timestamp: timestamp
                    };

                } catch (txError) {
                    return {
                        ...event,
                        txn_hash: null,
                        error: `Failed to fetch txn_hash for version ${event.transaction_version}`
                    };
                }
            }));

            console.log(JSON.stringify(enrichedEvents));
            return;

        } catch (error) {
            retryCount++;
            if (retryCount > MAX_RETRIES) {
                console.log(
                    JSON.stringify({
                        error: error instanceof Error ? error.message : "Unknown error occurred",
                    })
                );
                process.exit(1);
            }
        }
    }
}


async function ledgerInfo( client: Aptos)
{
  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      const ledgerInfo = await client.getLedgerInfo();
      const block = await client.getBlockByHeight({ blockHeight: Number(ledgerInfo.block_height) });
      console.log("Ledger Info:", ledgerInfo);
      console.log(
        JSON.stringify({ blockHeight: ledgerInfo.block_height})
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
      eventFlag,
      toTransactionVersion,
      contractAddress,
    ] = process.argv.slice(2);
    
  const config = new AptosConfig({ network: Network.MAINNET });
  const client = new Aptos(config);


  if (client)
    switch (eventFlag) {
      case "1":
        await ledgerInfo(client);
        break;
      case "2":
        contractAddress.startsWith("0x") ? contractAddress : `0x${contractAddress}`
        const gatewayEventTypes = [
            `0x${contractAddress}::gateway_contract::ISendEvent`,
            `0x${contractAddress}::gateway_contract::IReceiveEvent`,
            `0x${contractAddress}::gateway_contract::IAckEvent`,
            `0x${contractAddress}::gateway_contract::SetDappMetadataEvent`,
            `0x${contractAddress}::gateway_contract::ValsetUpdatedEvent`
          ];
        await fetchContractEvents(
          client,
          toTransactionVersion,
          gatewayEventTypes
        );
        break;
        case "3":
        contractAddress.startsWith("0x") ? contractAddress : `0x${contractAddress}`
        const voyagerEventTypes = [
            `0x${contractAddress}::gateway_contract::FundsDeposited`,
            `0x${contractAddress}::gateway_contract::FundsDepositedWithMessage`,
            `0x${contractAddress}::gateway_contract::FundsPaid`,
            `0x${contractAddress}::gateway_contract::FundsPaidWithMessage`,
            `0x${contractAddress}::gateway_contract::DepositInfoUpdate`
          ];
        await fetchContractEvents(
          client,
          toTransactionVersion,
          voyagerEventTypes
        );
        break;
      default:
        console.log(
          JSON.stringify({ 
              error : "Invalid function flag"
          })
        );
        process.exit(1);
    }
};


main()
