// ============================================================================
// Netlify Function — proxy sécurisé vers Helius
// ----------------------------------------------------------------------------
// Ce fichier ne tourne JAMAIS dans le navigateur du visiteur. Il tourne sur
// les serveurs de Netlify, uniquement quand ton site l'appelle. La clé
// Helius vit dans une variable d'environnement (process.env.HELIUS_API_KEY),
// configurée dans le dashboard Netlify — jamais écrite ici en clair.
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
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [address, { encoding: 'jsonParsed' }],
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
