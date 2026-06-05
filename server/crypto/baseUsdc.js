// server/crypto/baseUsdc.js
// ============================================================================
//  USDC-on-Base deposit/withdrawal helpers (ethers v6).
//
//  Single-token, single-treasury design. Everything is driven by env vars
//  and OFF by default (CRYPTO_ENABLED=false). Mainnet only activates when
//  CRYPTO_NETWORK=base + BASE_CHAIN_ID=8453 + the mainnet USDC contract are
//  set explicitly — the defaults here are Base Sepolia testnet.
//
//  Security: TREASURY_PRIVATE_KEY is read here, on the server, only inside
//  broadcastUsdcWithdrawal(). It is NEVER returned by getCryptoConfig() and
//  never sent to the client.
// ============================================================================
const { ethers } = require('ethers');

// Minimal ERC-20 ABI — just what we need to read decimals/balance, transfer
// from the treasury, and parse Transfer events on deposit receipts.
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

function envBool(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return String(v).toLowerCase() === 'true';
}

// Public config — safe to expose (NO private key). Read fresh each call so a
// runtime env change (tests) is picked up.
function getCryptoConfig() {
  const enabled         = envBool('CRYPTO_ENABLED', false);
  const rpcUrl          = process.env.BASE_RPC_URL || '';
  const treasuryAddress = process.env.TREASURY_ADDRESS || '';
  // `ready` gates the user-facing deposit/withdraw/link routes. Being merely
  // ENABLED is not enough — without an RPC URL we can't verify deposits, and
  // without a treasury address users would have nowhere to send funds. This
  // prevents the dangerous "enabled but misconfigured" state where someone
  // could send real USDC toward a blank/wrong address. The treasury PRIVATE
  // key is only needed at admin-approval (broadcast) time, so it's not part
  // of this gate.
  const ready = enabled && !!rpcUrl && !!treasuryAddress;
  return {
    enabled,
    ready,
    network:                process.env.CRYPTO_NETWORK || 'base-sepolia',
    chainId:                Number(process.env.BASE_CHAIN_ID || 84532),
    rpcUrl,
    usdcContractAddress:    process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDecimals:           Number(process.env.USDC_DECIMALS || 6),
    treasuryAddress,
    usdcToCreditsRate:      Number(process.env.USDC_TO_CREDITS_RATE || 100),
    minDepositUsdc:         Number(process.env.MIN_DEPOSIT_USDC || 1),
    minWithdrawUsdc:        Number(process.env.MIN_WITHDRAW_USDC || 1),
    depositConfirmations:   Number(process.env.DEPOSIT_CONFIRMATIONS || 3),
    withdrawalConfirmations:Number(process.env.WITHDRAWAL_CONFIRMATIONS || 3),
    withdrawalsAutoEnabled: envBool('WITHDRAWALS_AUTO_ENABLED', false),
    withdrawalsManualReview:envBool('WITHDRAWALS_MANUAL_REVIEW', true),
  };
}

// ── Provider / contract ─────────────────────────────────────────────────────
let _provider = null;
let _providerKey = '';
function getProvider() {
  const cfg = getCryptoConfig();
  if (!cfg.rpcUrl) return null;
  // Re-create if the RPC URL or chain changed (tests / config reloads).
  const key = `${cfg.rpcUrl}#${cfg.chainId}`;
  if (!_provider || _providerKey !== key) {
    _provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
    _providerKey = key;
  }
  return _provider;
}

function getUsdcContract(runner) {
  const cfg = getCryptoConfig();
  const r = runner || getProvider();
  if (!r) return null;
  return new ethers.Contract(cfg.usdcContractAddress, ERC20_ABI, r);
}

// ── Address helpers ─────────────────────────────────────────────────────────
function isValidAddress(address) {
  try { return ethers.isAddress(address); } catch (_) { return false; }
}
// Returns the checksummed address, or throws if invalid.
function normalizeAddress(address) {
  return ethers.getAddress(address);
}

// ── Amount conversions ──────────────────────────────────────────────────────
// USDC decimal string → raw base-unit bigint, and back.
function usdcDecimalToUnits(amountUsdc) {
  const cfg = getCryptoConfig();
  return ethers.parseUnits(String(amountUsdc), cfg.usdcDecimals);
}
function usdcUnitsToDecimal(units) {
  const cfg = getCryptoConfig();
  return ethers.formatUnits(BigInt(units), cfg.usdcDecimals);
}

// Integer-exact credits from raw on-chain units (floors any sub-credit dust).
//   credits = units * rate / 10^decimals
function creditsFromUnits(units) {
  const cfg = getCryptoConfig();
  const u = BigInt(units);
  const credits = (u * BigInt(cfg.usdcToCreditsRate)) / (10n ** BigInt(cfg.usdcDecimals));
  return Number(credits);
}
// Convenience for the request path where the input is a USDC decimal amount.
function usdcToCredits(amountUsdc) {
  const cfg = getCryptoConfig();
  return Math.round(Number(amountUsdc) * cfg.usdcToCreditsRate);
}
function creditsToUsdc(credits) {
  const cfg = getCryptoConfig();
  return Number(credits) / cfg.usdcToCreditsRate;
}

// ── Deposit verification ────────────────────────────────────────────────────
// Returns one of:
//   { status:'pending',   ...details }  not enough confirmations yet
//   { status:'confirmed', ...details }  ready to credit
//   { status:'rejected',  reason }      permanently invalid
//   { status:'error',     reason }      transient (RPC/config) — retry later
async function verifyUsdcDepositTx(txHash, expectedFromAddress) {
  const cfg = getCryptoConfig();
  const provider = getProvider();
  if (!provider) return { status: 'error', reason: 'provider_unavailable' };
  if (!cfg.treasuryAddress) return { status: 'error', reason: 'treasury_not_configured' };

  let from, treasury, usdc;
  try {
    from     = ethers.getAddress(expectedFromAddress);
    treasury = ethers.getAddress(cfg.treasuryAddress);
    usdc     = ethers.getAddress(cfg.usdcContractAddress);
  } catch (_) {
    return { status: 'rejected', reason: 'bad_address' };
  }

  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); }
  catch (_) { return { status: 'error', reason: 'rpc_error' }; }
  if (!receipt) return { status: 'pending', reason: 'no_receipt', confirmations: 0 };
  if (receipt.status !== 1) return { status: 'rejected', reason: 'tx_failed' };

  // Correct chain.
  let net;
  try { net = await provider.getNetwork(); } catch (_) { return { status: 'error', reason: 'rpc_error' }; }
  if (Number(net.chainId) !== cfg.chainId) return { status: 'rejected', reason: 'wrong_chain' };

  // Find a USDC Transfer(from → treasury) in the receipt logs.
  const iface = new ethers.Interface(ERC20_ABI);
  let valueUnits = null;
  for (const log of receipt.logs) {
    let addr;
    try { addr = ethers.getAddress(log.address); } catch (_) { continue; }
    if (addr !== usdc) continue;                       // wrong token
    let parsed;
    try { parsed = iface.parseLog({ topics: log.topics, data: log.data }); }
    catch (_) { continue; }
    if (!parsed || parsed.name !== 'Transfer') continue;
    let lf, lt;
    try { lf = ethers.getAddress(parsed.args.from); lt = ethers.getAddress(parsed.args.to); }
    catch (_) { continue; }
    if (lf === from && lt === treasury) { valueUnits = parsed.args.value; break; }
  }
  if (valueUnits == null) return { status: 'rejected', reason: 'no_matching_transfer' };

  const minUnits = ethers.parseUnits(String(cfg.minDepositUsdc), cfg.usdcDecimals);
  if (valueUnits < minUnits) return { status: 'rejected', reason: 'below_min_deposit' };

  // Confirmations from current head.
  let confirmations = 0;
  try {
    const head = await provider.getBlockNumber();
    confirmations = Math.max(0, head - receipt.blockNumber + 1);
  } catch (_) { /* leave at 0 → treated as pending */ }

  const details = {
    chain:         cfg.network,
    txHash,
    fromAddress:   from,
    toAddress:     treasury,
    tokenAddress:  usdc,
    amountUnits:   valueUnits.toString(),
    amountUsdc:    ethers.formatUnits(valueUnits, cfg.usdcDecimals),
    creditsAmount: creditsFromUnits(valueUnits),
    confirmations,
  };
  if (confirmations < cfg.depositConfirmations) return { status: 'pending', ...details };
  return { status: 'confirmed', ...details };
}

// ── Withdrawal broadcast (treasury → user) ──────────────────────────────────
// Uses TREASURY_PRIVATE_KEY (server-only). Returns the submitted tx hash.
async function broadcastUsdcWithdrawal(toAddress, amountUnits) {
  const cfg = getCryptoConfig();
  const provider = getProvider();
  if (!provider) throw new Error('provider_unavailable');
  if (!process.env.TREASURY_PRIVATE_KEY) throw new Error('treasury_key_missing');
  const to = ethers.getAddress(toAddress);
  const wallet = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
  const usdc = new ethers.Contract(cfg.usdcContractAddress, ERC20_ABI, wallet);
  const tx = await usdc.transfer(to, BigInt(amountUnits));
  return { txHash: tx.hash };
}

// ── Confirmations for an arbitrary tx (used to confirm withdrawals) ──────────
async function getTxConfirmations(txHash) {
  const provider = getProvider();
  if (!provider) return { confirmations: 0, status: 'unknown' };
  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); }
  catch (_) { return { confirmations: 0, status: 'unknown' }; }
  if (!receipt) return { confirmations: 0, status: 'pending' };
  let confirmations = 0;
  try {
    const head = await provider.getBlockNumber();
    confirmations = Math.max(0, head - receipt.blockNumber + 1);
  } catch (_) {}
  return { confirmations, status: receipt.status === 1 ? 'success' : 'failed' };
}

module.exports = {
  ERC20_ABI,
  getCryptoConfig,
  getProvider,
  getUsdcContract,
  normalizeAddress,
  isValidAddress,
  usdcDecimalToUnits,
  usdcUnitsToDecimal,
  usdcToCredits,
  creditsToUsdc,
  creditsFromUnits,
  verifyUsdcDepositTx,
  broadcastUsdcWithdrawal,
  getTxConfirmations,
};
