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
   Statut par signal :
   ✅ checkMintAuthority   → BRANCHÉ EN VRAI (RPC public Solana)
   🔶 les 5 autres         → encore SIMULÉS, à brancher un par un ensuite
   (Helius pour les holders/historique créateur, pump.fun pour la liquidité)

   Toutes les fonctions renvoient la même "forme" de résultat, que ce soit
   du vrai ou du simulé — c'est ce qui permet de les remplacer une par une
   sans toucher au reste du site :
   { status: 'ok' | 'warning' | 'danger', detail: string, raw: string }
   -------------------------------------------------------------------------- */

// Signal 1 — Concentration des holders
// TODO (réel) : Helius "getTokenAccounts" / "getTokenLargestAccounts" du RPC,
// puis calculer la part du supply détenue par les 1-2 plus gros wallets.
function checkHolderConcentration(rng) {
  const topHolderPct = Math.round(rng() * 70); // 0-70%
  let status = 'ok';
  if (topHolderPct > 40) status = 'danger';
  else if (topHolderPct > 20) status = 'warning';
  return {
    status,
    detail: `The largest wallet holds ${topHolderPct}% of total supply.`,
    raw: `top1_holder_pct=${topHolderPct}`,
  };
}

// Signal 2 — Âge du token
// TODO (réel) : timestamp de la transaction de création du mint (RPC
// getSignaturesForAddress, la plus ancienne signature).
function checkTokenAge(rng) {
  const ageHours = Math.round(rng() * 400); // 0-400h
  let status = 'ok';
  if (ageHours < 6) status = 'danger';
  else if (ageHours < 48) status = 'warning';
  const label = ageHours < 24 ? `${ageHours}h` : `${Math.round(ageHours / 24)} days`;
  return {
    status,
    detail: `This token has existed for about ${label}.`,
    raw: `age_hours=${ageHours}`,
  };
}

// Signal 3 — Liquidité verrouillée ou non
// TODO (réel) : vérifier si le LP token est burn/verrouillé (souvent visible
// via l'API pump.fun une fois le token "gradué", ou via le programme de
// verrouillage utilisé, ex. Streamflow).
function checkLiquidityLock(rng) {
  const locked = rng() > 0.45;
  return {
    status: locked ? 'ok' : 'danger',
    detail: locked
      ? `Liquidity is locked or burned (LP cannot be pulled by the creator).`
      : `No liquidity lock detected. The creator can pull liquidity at any time.`,
    raw: `lp_locked=${locked}`,
  };
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
// TODO (réel) : agréger le volume 24h (Helius / DEX aggregator) et le
// diviser par le market cap courant.
function checkVolumeRatio(rng) {
  const ratio = +(rng() * 3).toFixed(2); // 0 - 3x
  let status = 'ok';
  if (ratio > 1.8) status = 'danger';
  else if (ratio > 0.9) status = 'warning';
  return {
    status,
    detail: `24h volume / market cap ratio: ${ratio}x${ratio > 1.8 ? ' — likely wash trading.' : '.'}`,
    raw: `vol_mcap_ratio=${ratio}`,
  };
}

// Signal 6 — Historique du wallet créateur
// TODO (réel) : lister les tokens précédemment créés par ce wallet
// (via Helius "parsed transaction history" sur ce wallet) et croiser
// avec un signal de rug (liquidité retirée peu après création, etc.)
function checkCreatorHistory(rng) {
  const priorRugs = Math.floor(rng() * 4); // 0-3
  let status = 'ok';
  if (priorRugs >= 2) status = 'danger';
  else if (priorRugs === 1) status = 'warning';
  return {
    status,
    detail: priorRugs === 0
      ? `No known rug pull history for this creator wallet.`
      : `This wallet has created ${priorRugs} other token(s) linked to a possible rug pull.`,
    raw: `creator_prior_rugs=${priorRugs}`,
  };
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
