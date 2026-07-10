// ============================================================================
// Netlify Function — proxy sécurisé vers Helius : âge du token
// ----------------------------------------------------------------------------
// getSignaturesForAddress renvoie les transactions de la plus récente à la
// plus ancienne, par pages de 1000 maximum. Pour un token très actif (gros
// volume d'échanges), 1000 transactions peuvent ne représenter que
// quelques heures ! On remonte donc page par page (paramètre "before")
// jusqu'à atteindre la vraie première transaction — avec une limite de
// pages pour éviter que la fonction ne tourne indéfiniment sur un token
// avec un historique énorme. Si on atteint cette limite sans trouver le
// début, on le signale honnêtement ("au moins X" plutôt qu'un chiffre faux).
// ============================================================================

const MAX_PAGES = 15; // 15 000 transactions max explorées

exports.handler = async function (event) {
  const address = event.queryStringParameters?.address;

  if (!address) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing "address" query parameter' }),
    };
  }

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

  if (!HELIUS_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'HELIUS_API_KEY is not configured on the server' }),
    };
  }

  const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const rpcCall = (method, params) =>
    fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((r) => r.json());

  try {
    console.log('token-age: calling Helius for', address);

    let before;
    let oldestSignature = null;
    let reachedGenesis = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = before
        ? [address, { limit: 1000, before }]
        : [address, { limit: 1000 }];

      const data = await rpcCall('getSignaturesForAddress', params);
      const sigs = data?.result;

      if (!sigs || sigs.length === 0) break;

      oldestSignature = sigs[sigs.length - 1];

      if (sigs.length < 1000) {
        reachedGenesis = true;
        break;
      }

      before = oldestSignature.signature;
    }

    if (!oldestSignature) {
      throw new Error('no transaction history found for this address');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldest: oldestSignature, reachedGenesis }),
    };
  } catch (err) {
    console.error('token-age function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
