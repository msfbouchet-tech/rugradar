// ============================================================================
// Netlify Function — proxy vers l'API publique pump.fun (tokens d'un créateur)
// ============================================================================

exports.handler = async function (event) {
  const creator = event.queryStringParameters?.creator;

  if (!creator) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing "creator" query parameter' }),
    };
  }

  try {
    const response = await fetch(
      `https://frontend-api.pump.fun/coins?creator=${creator}&limit=50&offset=0`,
      { headers: { Accept: 'application/json' } }
    );

    const coins = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coins }),
    };
  } catch (err) {
    console.error('pumpfun-creator function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
