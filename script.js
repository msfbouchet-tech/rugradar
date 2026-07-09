/* ==========================================================================
   SCANNER DE RISQUE TOKEN SOLANA — v1 (données simulées)
   --------------------------------------------------------------------------
   Comment lire ce fichier :
   1. Utilitaires (hash, générateur pseudo-aléatoire)
   2. "checkers" — une fonction par signal de risque (ICI sera branché Helius/RPC)
   3. Orchestrateur : analyzeToken() qui appelle les 6 checkers
   4. Rendu visuel (DOM) + gestion du formulaire
   ========================================================================== */


/* --------------------------------------------------------------------------
   1) UTILITAIRES
   -------------------------------------------------------------------------- */

// Transforme une adresse (string) en nombre "seed". Ça sert à obtenir
// TOUJOURS le même résultat simulé pour la même adresse (comme un vrai
// scan serait cohérent d'un appel à l'autre).
function hashAddress(address) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash << 5) - hash + address.charCodeAt(i);
    hash |= 0; // force un entier 32 bits
  }
  return Math.abs(hash);
}

// Petit générateur pseudo-aléatoire "seedé" (mulberry32).
// Contrairement à Math.random(), il produit toujours la même suite
// de nombres si on lui donne la même seed.
function createRng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shortAddr(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}


/* --------------------------------------------------------------------------
   2) CHECKERS — un par signal de risque
   --------------------------------------------------------------------------
   Statut par signal — TOUT est maintenant branché en réel :
   ✅ checkHolderConcentration  → Helius (via fonction serveur)
   ✅ checkTokenAge             → Helius (via fonction serveur)
   ✅ checkLiquidityLock        → pump.fun (via fonction serveur)
   ✅ checkMintAuthority        → Helius (via fonction serveur)
   ✅ checkVolumeRatio          → DexScreener (appel direct, pas de clé)
   ✅ checkCreatorHistory       → pump.fun (via fonction serveur)

   Toutes les fonctions renvoient la même "forme" de résultat :
   { status: 'ok' | 'warning' | 'danger', detail: string, raw: string }
   -------------------------------------------------------------------------- */

// Signal 1 — Concentration des holders
// TODO (réel) : Helius "getTokenAccounts" / "getTokenLargestAccounts" du RPC,
// puis calculer la part du supply détenue par les 1-2 plus gros wallets.
// ✅ BRANCHÉ EN VRAI : appelle notre fonction serveur qui interroge Helius.
async function checkHolderConcentration(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/holder-concentration?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);
    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }
    const { largest, supply } = await response.json();

    const largestAccounts = largest?.result?.value;
    const totalSupply = supply?.result?.value?.uiAmount;

    if (!largestAccounts || largestAccounts.length === 0 || !totalSupply) {
      throw new Error('unexpected data shape from RPC');
    }

    const topAmount = largestAccounts[0].uiAmount ?? 0;
    const topHolderPct = Math.round((topAmount / totalSupply) * 100);

    let status = 'ok';
    if (topHolderPct > 40) status = 'danger';
    else if (topHolderPct > 20) status = 'warning';

    return {
      status,
      detail: `The largest token account holds ${topHolderPct}% of total supply. (Note: this may be a liquidity pool, not a single holder.)`,
      raw: `top1_holder_pct=${topHolderPct}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify holder concentration live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

// Signal 2 — Âge du token
// ✅ BRANCHÉ EN VRAI : appelle notre fonction serveur qui interroge Helius.
async function checkTokenAge(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/token-age?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);
    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }
    const json = await response.json();
    const signatures = json?.result;

    if (!signatures || signatures.length === 0) {
      throw new Error('no transaction history found for this address');
    }

    // La dernière de la liste = la plus ancienne transaction reçue.
    const oldest = signatures[signatures.length - 1];
    const createdAtMs = oldest.blockTime * 1000;
    const ageHours = Math.round((Date.now() - createdAtMs) / (1000 * 60 * 60));

    let status = 'ok';
    if (ageHours < 6) status = 'danger';
    else if (ageHours < 48) status = 'warning';

    const label = ageHours < 24 ? `${ageHours}h` : `${Math.round(ageHours / 24)} days`;

    return {
      status,
      detail: `This token has existed for about ${label}.`,
      raw: `age_hours=${ageHours}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify token age live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

// Signal 3 — Liquidité verrouillée ou non
// ✅ BRANCHÉ EN VRAI : utilise le statut "gradué" de pump.fun. Une fois
// gradué vers Raydium, pump.fun brûle automatiquement les tokens LP —
// avant graduation, la liquidité vit sur la bonding curve, un programme
// que le créateur ne contrôle pas non plus. Dans les deux cas, le créateur
// ne peut pas retirer la liquidité lui-même.
async function checkLiquidityLock(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/pumpfun-coin?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);
    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }
    const json = await response.json();

    if (!json.found) {
      return {
        status: 'warning',
        detail: `This token was not found on pump.fun — cannot verify liquidity lock status automatically.`,
        raw: `pumpfun_found=false`,
      };
    }

    const graduated = Boolean(json.coin.complete);

    return {
      status: 'ok',
      detail: graduated
        ? `Token has graduated to Raydium; pump.fun automatically burns LP tokens on graduation.`
        : `Token is still on pump.fun's bonding curve; liquidity is program-controlled and cannot be withdrawn by the creator.`,
      raw: `pumpfun_complete=${graduated}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify liquidity status live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

// Signal 4 — Autorité de mint
// ✅ BRANCHÉ EN VRAI : appel direct au RPC public Solana (aucune clé API
// nécessaire). On demande les infos du compte "mint" en format déjà décodé
// ("jsonParsed") — le RPC nous renvoie directement les champs qui nous
// intéressent, pas besoin de décoder des données binaires nous-mêmes.
async function checkMintAuthority(rng, address) {
  // ✅ On n'appelle plus Helius directement (la clé API resterait visible
  // dans le code du navigateur). On appelle notre propre fonction serveur
  // ("/.netlify/functions/mint-authority"), qui elle connaît la clé et fait
  // l'appel à notre place. Voir netlify/functions/mint-authority.js
  const FUNCTION_URL = `/.netlify/functions/mint-authority?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);

    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }

    const json = await response.json();

    // Chemin dans la réponse JSON-RPC : result.value.data.parsed.info
    const info = json?.result?.value?.data?.parsed?.info;

    if (!info) {
      // Soit l'adresse n'est pas un mint SPL valide, soit elle n'existe pas.
      throw new Error("invalid address or not an SPL token");
    }

    const mintAuthority = info.mintAuthority;     // null = révoquée
    const freezeAuthority = info.freezeAuthority; // null = révoquée

    const mintRevoked = mintAuthority === null || mintAuthority === undefined;
    const freezeRevoked = freezeAuthority === null || freezeAuthority === undefined;

    let status = mintRevoked ? 'ok' : 'warning';
    let detail = mintRevoked
      ? `Mint authority revoked: supply can no longer be increased.`
      : `Mint authority still active (${shortAddr(mintAuthority)}): the creator can mint new tokens at will.`;

    if (!freezeRevoked) {
      status = 'danger';
      detail += ` On top of that, freeze authority is active: the creator can freeze holder wallets at any time.`;
    }

    return {
      status,
      detail,
      raw: `mint_authority=${mintAuthority ?? 'null'} | freeze_authority=${freezeAuthority ?? 'null'}`,
    };
  } catch (err) {
    // Le RPC public a des limites de débit strictes, et peut parfois
    // refuser une requête ou timeout. On ne casse jamais tout le rapport
    // pour ça : on affiche l'erreur comme signal "à vérifier manuellement".
    return {
      status: 'warning',
      detail: `Could not verify mint authority live (${err.message}).`,
      raw: `rpc_error=${err.message}`,
    };
  }
}

// Signal 5 — Ratio volume / market cap
// ✅ BRANCHÉ EN VRAI : API publique DexScreener, gratuite et sans clé — pas
// besoin de passer par une fonction serveur ici, il n'y a aucun secret à
// protéger et DexScreener autorise les appels directs depuis un navigateur.
async function checkVolumeRatio(rng, address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!response.ok) {
      throw new Error(`DexScreener responded with status ${response.status}`);
    }
    const json = await response.json();
    const pairs = json?.pairs;

    if (!pairs || pairs.length === 0) {
      throw new Error('no trading pair found on DexScreener');
    }

    // Plusieurs pools peuvent exister pour un même token ; on prend celui
    // avec le plus de liquidité, généralement le plus représentatif.
    const pair = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));

    const volume24h = pair.volume?.h24 ?? 0;
    const marketCap = pair.marketCap ?? pair.fdv ?? 0;

    if (!marketCap) {
      throw new Error('market cap unavailable for this pair');
    }

    const ratio = +(volume24h / marketCap).toFixed(2);

    let status = 'ok';
    if (ratio > 1.8) status = 'danger';
    else if (ratio > 0.9) status = 'warning';

    return {
      status,
      detail: `24h volume / market cap ratio: ${ratio}x${ratio > 1.8 ? ' — likely wash trading.' : '.'}`,
      raw: `vol_mcap_ratio=${ratio}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify volume/market cap ratio live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

// Signal 6 — Historique du wallet créateur
// ✅ BRANCHÉ EN VRAI : liste les autres tokens créés par ce wallet via
// pump.fun. Important : on ne peut pas affirmer avec certitude qu'un token
// passé a "rug pull" à partir de données publiques simples (ça demanderait
// une analyse de prix historique poussée) — on reste donc honnête et on
// affiche un COMPTE de tokens déjà lancés, pas une accusation. Un nombre
// élevé reste un vrai signal d'alerte (pattern de "serial launcher").
async function checkCreatorHistory(rng, address) {
  try {
    const coinResp = await fetch(`/.netlify/functions/pumpfun-coin?address=${encodeURIComponent(address)}`);
    if (!coinResp.ok) {
      throw new Error(`server function responded with status ${coinResp.status}`);
    }
    const coinJson = await coinResp.json();

    if (!coinJson.found || !coinJson.coin?.creator) {
      return {
        status: 'warning',
        detail: `Could not determine the creator wallet for this token (not found on pump.fun).`,
        raw: `creator_found=false`,
      };
    }

    const creator = coinJson.coin.creator;
    const listResp = await fetch(`/.netlify/functions/pumpfun-creator?creator=${encodeURIComponent(creator)}`);
    if (!listResp.ok) {
      throw new Error(`server function responded with status ${listResp.status}`);
    }
    const listJson = await listResp.json();
    const coins = Array.isArray(listJson.coins) ? listJson.coins : [];
    const otherTokensCount = Math.max(0, coins.length - 1); // exclut le token scanné lui-même

    let status = 'ok';
    if (otherTokensCount >= 5) status = 'danger';
    else if (otherTokensCount >= 1) status = 'warning';

    return {
      status,
      detail: otherTokensCount === 0
        ? `This is the only token launched by this creator wallet, based on pump.fun's public data.`
        : `This creator wallet has launched ${otherTokensCount} other token(s) on pump.fun. A high count can signal a serial-launch pattern — worth checking individually.`,
      raw: `creator_token_count=${otherTokensCount}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify creator history live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}


/* --------------------------------------------------------------------------
   3) ORCHESTRATEUR
   -------------------------------------------------------------------------- */

const EXHIBITS_CONFIG = [
  { key: 'holders',   title: 'Holder concentration',    fn: checkHolderConcentration },
  { key: 'age',       title: 'Token age',                fn: checkTokenAge },
  { key: 'liquidity', title: 'Liquidity',                 fn: checkLiquidityLock },
  { key: 'mint',      title: 'Mint authority',            fn: checkMintAuthority },
  { key: 'volume',    title: 'Volume / market cap ratio', fn: checkVolumeRatio },
  { key: 'creator',   title: 'Creator history',           fn: checkCreatorHistory },
];

// Certains checkers sont encore simulés (synchrones), d'autres font
// maintenant un vrai appel réseau (asynchrones, ex. checkMintAuthority).
// `Promise.all` + `await` sur chaque résultat fonctionne pour les deux cas :
// attendre une valeur qui n'est pas une Promise ne pose aucun problème.
async function analyzeToken(address) {
  const seed = hashAddress(address);
  const rng = createRng(seed);

  const exhibits = await Promise.all(
    EXHIBITS_CONFIG.map(async (cfg, i) => ({
      ...cfg,
      num: String(i + 1).padStart(2, '0'),
      result: await cfg.fn(rng, address),
    }))
  );

  const score = computeScore(exhibits);

  return { address, seed, exhibits, score };
}

// Score global 0 (dangereux) → 100 (sûr).
// Logique simple : on part de 100 et on retire des points par problème détecté.
function computeScore(exhibits) {
  let score = 100;
  for (const ex of exhibits) {
    if (ex.result.status === 'danger') score -= 22;
    if (ex.result.status === 'warning') score -= 9;
  }
  return Math.max(0, Math.min(100, score));
}

function verdictFromScore(score) {
  if (score >= 70) return { label: 'Safe', color: 'var(--teal)' };
  if (score >= 40) return { label: 'Caution', color: 'var(--amber)' };
  return { label: 'Danger', color: 'var(--red)' };
}


/* --------------------------------------------------------------------------
   4) RENDU / DOM
   -------------------------------------------------------------------------- */

const form          = document.getElementById('scan-form');
const input          = document.getElementById('token-address');
const errorEl        = document.getElementById('intake-error');
const intakeSection  = document.querySelector('.intake');
const scanningState  = document.getElementById('scanning-state');
const scanningLog    = document.getElementById('scanning-log');
const reportState    = document.getElementById('report-state');
const resetBtn       = document.getElementById('reset-btn');

const SCAN_LOG_MESSAGES = [
  'Connecting to the on-chain registry…',
  'Reading holder distribution…',
  'Checking mint authority…',
  'Analyzing liquidity…',
  'Computing volume / market cap ratio…',
  'Looking up creator history…',
  'Compiling the case file…',
];

function isPlausibleSolanaAddress(str) {
  // Une adresse Solana est en base58, généralement 32-44 caractères.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str.trim());
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = input.value.trim();

  errorEl.hidden = true;
  if (!isPlausibleSolanaAddress(address)) {
    errorEl.textContent = 'This does not look like a valid Solana address (32-44 base58 characters).';
    errorEl.hidden = false;
    return;
  }

  intakeSection.hidden = true;
  reportState.hidden = true;
  scanningState.hidden = false;
  scanningLog.innerHTML = '';

  await playScanningLog();

  const data = await analyzeToken(address);
  renderReport(data);

  scanningState.hidden = true;
  reportState.hidden = false;
});

function playScanningLog() {
  return new Promise((resolve) => {
    let i = 0;
    const interval = setInterval(() => {
      if (i > 0) {
        const prev = scanningLog.children[i - 1];
        if (prev) prev.classList.add('done');
      }
      if (i < SCAN_LOG_MESSAGES.length) {
        const p = document.createElement('p');
        p.style.animationDelay = '0s';
        p.innerHTML = `› ${SCAN_LOG_MESSAGES[i]} <span class="cursor"></span>`;
        scanningLog.appendChild(p);
        i++;
      } else {
        clearInterval(interval);
        setTimeout(resolve, 300);
      }
    }, 260);
  });
}

function renderReport(data) {
  document.getElementById('report-caseid').textContent = String(data.seed).slice(0, 6);
  document.getElementById('report-address').textContent = data.address;

  const verdict = verdictFromScore(data.score);
  const stampRing = document.getElementById('verdict-stamp').querySelector('.stamp__ring');
  stampRing.style.setProperty('--verdict-color', verdict.color);
  document.getElementById('stamp-text').textContent = verdict.label;
  document.getElementById('stamp-score').textContent = `${data.score}/100`;

  // Relance l'animation du tampon à chaque nouveau scan
  stampRing.style.animation = 'none';
  void stampRing.offsetWidth; // force reflow
  stampRing.style.animation = '';

  const list = document.getElementById('exhibits-list');
  list.innerHTML = '';

  const statusColor = { ok: 'var(--teal)', warning: 'var(--amber)', danger: 'var(--red)' };
  const statusLabel = { ok: 'OK', warning: 'Caution', danger: 'Risk' };

  for (const ex of data.exhibits) {
    const color = statusColor[ex.result.status];
    const card = document.createElement('div');
    card.className = 'exhibit';
    card.style.setProperty('--exhibit-color', color);
    card.innerHTML = `
      <span class="exhibit__num">${ex.num}</span>
      <div>
        <p class="exhibit__title">${ex.title}</p>
        <p class="exhibit__detail">${ex.result.detail}</p>
        <span class="exhibit__raw">${ex.result.raw}</span>
      </div>
      <span class="exhibit__badge">${statusLabel[ex.result.status]}</span>
    `;
    list.appendChild(card);
  }
}

resetBtn.addEventListener('click', () => {
  reportState.hidden = true;
  intakeSection.hidden = false;
  input.value = '';
  input.focus();
});
