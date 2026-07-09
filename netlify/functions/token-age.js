// ============================================================================
// Netlify Function — proxy sécurisé vers Helius : âge du token
// ----------------------------------------------------------------------------
// On demande l'historique des signatures (transactions) du compte mint, avec
// la limite maximum (1000). Comme les signatures sont renvoyées de la plus
// récente à la plus ancienne, on prend la DERNIÈRE de la liste reçue.
//
// ⚠️ Limite connue : si le token a plus de 1000 transactions au total, cette
// "dernière de la page" n'est pas forcément la toute première création —
// il faudrait paginer avec le paramètre "before". Pour un memecoin récent
// (peu de transactions), une seule page suffit largement.
// ============================================================================

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

  try {
    console.log('token-age: calling Helius for', address);

    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }],
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('token-age function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
