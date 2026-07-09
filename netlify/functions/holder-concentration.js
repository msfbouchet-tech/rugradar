// ============================================================================
// Netlify Function — proxy sécurisé vers Helius : concentration des holders
// ----------------------------------------------------------------------------
// On fait 2 appels RPC en parallèle :
// 1) getTokenLargestAccounts → les 20 plus gros comptes détenant ce token
// 2) getTokenSupply         → le supply total en circulation
// On renvoie les deux bruts, c'est script.js qui calcule le pourcentage.
//
// ⚠️ Limite connue (documentée honnêtement) : "getTokenLargestAccounts"
// renvoie des comptes de tokens, pas des wallets. Un pool de liquidité
// (Raydium, etc.) apparaît souvent comme le "plus gros holder" — ce n'est
// pas forcément un signal de danger dans ce cas précis. On l'affiche quand
// même car ça reste un vrai indicateur utile, avec cette nuance en tête.
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

  const rpcCall = (method, params) =>
    fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((r) => r.json());

  try {
    console.log('holder-concentration: calling Helius for', address);

    const [largestData, supplyData] = await Promise.all([
      rpcCall('getTokenLargestAccounts', [address]),
      rpcCall('getTokenSupply', [address]),
    ]);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ largest: largestData, supply: supplyData }),
    };
  } catch (err) {
    console.error('holder-concentration function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
