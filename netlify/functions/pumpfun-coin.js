// ============================================================================
// Netlify Function — proxy vers l'API publique pump.fun (infos d'un coin)
// ----------------------------------------------------------------------------
// Pas de clé API nécessaire ici — on passe quand même par une fonction
// serveur pour éviter les soucis de CORS depuis le navigateur, comme on l'a
// vu avec le RPC Solana.
// ============================================================================

exports.handler = async function (event) {
  const address = event.queryStringParameters?.address;

  if (!address) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing "address" query parameter' }),
    };
  }

  try {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${address}`, {
      headers: { Accept: 'application/json' },
    });

    if (response.status === 404) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: false }),
      };
    }

    const coin = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: true, coin }),
    };
  } catch (err) {
    console.error('pumpfun-coin function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
