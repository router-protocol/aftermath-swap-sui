import { Aptos, AptosConfig, Network, OrderByValue } from "@aptos-labs/ts-sdk"


async function fetchContractEvents(
    client: Aptos,
    toTransactionVersion : string,
    eventType: string,
) {

  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      const options = {
        limit: 100,
        offset: 0, // Start from the latest events
        orderBy: [{ transaction_version: "desc" as OrderByValue }], // Fetch from latest
      };
  
      const events = await client.getModuleEventsByEventType({
        eventType: eventType as `${string}::${string}::${string}`,
        options,
      });

      // Filter events to include only those >= toTransactionVersion
      const filteredEvents = events.filter(event => parseInt(event.transaction_version) >= Number(toTransactionVersion));
  
      // Sort in ASCENDING order before returning
      filteredEvents.sort((a, b) => parseInt(a.transaction_version) - parseInt(b.transaction_version));

      // Fetch transaction hash for each event
      const enrichedEvents = await Promise.all(filteredEvents.map(async (event) => {
        try {
          const txData = await client.getTransactionByVersion({ ledgerVersion: Number(event.transaction_version) });
          return {
            ...event,
            txn_hash: txData.hash, // Adding the transaction hash to the event
          };
        } catch (txError) {
          return { 
            ...event, 
            txn_hash: null, // Fallback in case of error
            error: `Failed to fetch txn_hash for version ${event.transaction_version}`
          };
        }
      }));

      // Output clean JSON for Go script
      console.log(JSON.stringify(enrichedEvents));
      
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

async function ledgerInfo( client: Aptos)
{
  const MAX_RETRIES = 5; // Maximum number of retries
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      const ledgerInfo = await client.getLedgerInfo();
      console.log(
        JSON.stringify({ blockHeight: ledgerInfo.ledger_version})
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

async function fetchCCTPEvents(
  client: Aptos,
  toTransactionVersion : string,
  eventType: string,
  messageTransmitter: string,
) {

const MAX_RETRIES = 5; // Maximum number of retries
let retryCount = 0;
while (retryCount <= MAX_RETRIES) {
  try {
    const options = {
      limit: 100,
      offset: 0, // Start from the latest events
      orderBy: [{ transaction_version: "desc" as OrderByValue }], // Fetch from latest
    };

    const events = await client.getModuleEventsByEventType({
      eventType: eventType as `${string}::${string}::${string}`,
      options,
    });

    // Filter events to include only those >= toTransactionVersion
    const filteredEvents = events.filter(event => parseInt(event.transaction_version) >= Number(toTransactionVersion));

    // Sort in ASCENDING order before returning
    filteredEvents.sort((a, b) => parseInt(a.transaction_version) - parseInt(b.transaction_version));

    // Fetch transaction hash for each event
    const enrichedEvents = await Promise.all(filteredEvents.map(async (event) => {
      try {
        const txData = await client.getTransactionByVersion({ ledgerVersion: Number(event.transaction_version) }); 
        // Ensure txData has an events property (i.e., it's a committed transaction)
        if ("events" in txData) {
          // Find the MessageSent event
          const messageEvent = txData.events.find(ev => 
              ev.type === messageTransmitter
          );

          // Extract the message data if the event is found
          const messageData = messageEvent ? messageEvent.data : null;

          return {
              ...event,
              txn_hash: txData.hash, // Adding transaction hash
              message_data: messageData // Extracted message data
          };
      } else {
          return {
              ...event,
              txn_hash: txData.hash,
              message_data: null, // No events available
              error: "Transaction is still pending or does not contain events."
          };
      }
      } catch (txError) {
        return { 
          ...event, 
          txn_hash: null, // Fallback in case of error
          error: `Failed to fetch txn_hash for version ${event.transaction_version}`
        };
      }
    }));

    // Output clean JSON for Go script
    console.log(JSON.stringify(enrichedEvents));
    
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
      eventType,
      messageTransmitter,
    ] = process.argv.slice(2);
    
  const config = new AptosConfig({ network: Network.TESTNET });
  const client = new Aptos(config);

  if (client)
    switch (eventFlag) {
      case "1":
        await ledgerInfo(client);
        break;
      case "2":
        await fetchContractEvents(
          client,
          toTransactionVersion,
          eventType.startsWith("0x") ? eventType : `0x${eventType}`
        );
        break;
      case "3":
        await fetchCCTPEvents(
          client,
          toTransactionVersion,
          eventType.startsWith("0x") ? eventType : `0x${eventType}`,
          messageTransmitter.startsWith("0x") ? messageTransmitter : `0x${messageTransmitter}`
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
