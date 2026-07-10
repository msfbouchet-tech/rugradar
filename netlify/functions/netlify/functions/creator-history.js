// ============================================================================
// Netlify Function — historique du créateur, via Helius (pas pump.fun)
// ----------------------------------------------------------------------------
// pump.fun a fermé son API publique derrière une authentification par compte
// depuis notre première intégration — on ne peut plus s'y fier pour un site
// public. On reconstruit ce signal avec seulement Helius :
//
// 1) getSignaturesForAddress sur le mint → la toute première transaction
// 2) getTransaction sur cette signature → le "fee payer" (1er compte signataire)
//    est quasi toujours le wallet qui a créé le token (il paie les frais de
//    création du compte mint)
// 3) API Enhanced Transactions de Helius, filtrée sur type=TOKEN_MINT, pour
//    compter combien d'autres tokens ce wallet a créés
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
    // Étape 1 — la plus ancienne transaction du mint
    const sigData = await rpcCall('getSignaturesForAddress', [address, { limit: 1000 }]);
    const signatures = sigData?.result;

    if (!signatures || signatures.length === 0) {
      throw new Error('no transaction history found for this mint');
    }

    const oldestSignature = signatures[signatures.length - 1].signature;

    // Étape 2 — le fee payer de cette transaction = quasi toujours le créateur
    const txData = await rpcCall('getTransaction', [
      oldestSignature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);

    const creator = txData?.result?.transaction?.message?.accountKeys?.[0]?.pubkey
      ?? txData?.result?.transaction?.message?.accountKeys?.[0];

    if (!creator) {
      throw new Error('could not identify creator wallet from oldest transaction');
    }

    // Étape 3 — API Enhanced Transactions Helius, comptage des créations de tokens
    const enhancedUrl = `https://api.helius.xyz/v0/addresses/${creator}/transactions?api-key=${HELIUS_API_KEY}&type=TOKEN_MINT&limit=100`;
    const enhancedResponse = await fetch(enhancedUrl);
    const enhancedData = await enhancedResponse.json();
    const mintEvents = Array.isArray(enhancedData) ? enhancedData : [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creator, mintEventCount: mintEvents.length }),
    };
  } catch (err) {
    console.error('creator-history function crashed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
