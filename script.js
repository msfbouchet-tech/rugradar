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

function hashAddress(address) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash << 5) - hash + address.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

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
   ✅ checkTokenAge             → Helius (via fonction serveur, paginé)
   ✅ checkLiquidityLock        → DexScreener (appel direct, pas de clé)
   ✅ checkMintAuthority        → Helius (via fonction serveur)
   ✅ checkVolumeRatio          → DexScreener (appel direct, pas de clé)
   ✅ checkCreatorHistory       → Helius (via fonction serveur)

   Toutes les fonctions renvoient la même "forme" de résultat :
   { status: 'ok' | 'warning' | 'danger', detail: string, raw: string }
   -------------------------------------------------------------------------- */

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

async function checkTokenAge(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/token-age?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);
    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }
    const { oldest, reachedGenesis } = await response.json();

    if (!oldest || !oldest.blockTime) {
      throw new Error('no transaction history found for this address');
    }

    const createdAtMs = oldest.blockTime * 1000;
    const ageHours = Math.round((Date.now() - createdAtMs) / (1000 * 60 * 60));

    let status = 'ok';
    if (ageHours < 6) status = 'danger';
    else if (ageHours < 48) status = 'warning';

    const label = ageHours < 24 ? `${ageHours}h` : `${Math.round(ageHours / 24)} days`;
    const prefix = reachedGenesis ? '' : 'at least ';

    return {
      status,
      detail: `This token has existed for ${prefix}about ${label}${reachedGenesis ? '' : ' (very high transaction volume — could be older)'}.`,
      raw: `age_hours=${ageHours}${reachedGenesis ? '' : ' (lower bound)'}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify token age live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

async function checkLiquidityLock(rng, address) {
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

    const pair = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    const liquidityUsd = Math.round(pair.liquidity?.usd ?? 0);

    let status = 'ok';
    if (liquidityUsd < 3000) status = 'danger';
    else if (liquidityUsd < 15000) status = 'warning';

    return {
      status,
      detail: `Liquidity depth: $${liquidityUsd.toLocaleString()}. (Note: this measures depth, not whether LP tokens are technically locked/burned — that requires the launchpad's own data, unavailable here.)`,
      raw: `liquidity_usd=${liquidityUsd}`,
    };
  } catch (err) {
    return {
      status: 'warning',
      detail: `Could not verify liquidity live (${err.message}).`,
      raw: `error=${err.message}`,
    };
  }
}

async function checkMintAuthority(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/mint-authority?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);

    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }

    const json = await response.json();
    const info = json?.result?.value?.data?.parsed?.info;

    if (!info) {
      throw new Error("invalid address or not an SPL token");
    }

    const mintAuthority = info.mintAuthority;
    const freezeAuthority = info.freezeAuthority;

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
    return {
      status: 'warning',
      detail: `Could not verify mint authority live (${err.message}).`,
      raw: `rpc_error=${err.message}`,
    };
  }
}

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

async function checkCreatorHistory(rng, address) {
  const FUNCTION_URL = `/.netlify/functions/creator-history?address=${encodeURIComponent(address)}`;

  try {
    const response = await fetch(FUNCTION_URL);
    if (!response.ok) {
      throw new Error(`server function responded with status ${response.status}`);
    }
    const { creator, mintEventCount } = await response.json();

    const otherTokensCount = Math.max(0, (mintEventCount ?? 1) - 1);

    let status = 'ok';
    if (otherTokensCount >= 5) status = 'danger';
    else if (otherTokensCount >= 1) status = 'warning';

    return {
      status,
      detail: otherTokensCount === 0
        ? `No other token creations found for this creator wallet (${shortAddr(creator)}) in recent history.`
        : `This creator wallet (${shortAddr(creator)}) has created ${otherTokensCount} other token(s) recently. A high count can signal a serial-launch pattern — worth checking individually.`,
      raw: `creator=${creator} | other_tokens=${otherTokensCount}`,
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

  stampRing.style.animation = 'none';
  void stampRing.offsetWidth;
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
