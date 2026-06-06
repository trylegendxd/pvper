// scripts/crypto-preflight.js
// ============================================================================
//  Read-only sanity check for the USDC/Base setup, to run BEFORE testing with
//  (test) money. Confirms the RPC works, you're on the right chain, and the
//  treasury holds ETH (for gas) + USDC (for payouts).
//
//  Uses ONLY public info — it never needs or touches the private key.
//
//  Usage:
//    BASE_RPC_URL=... TREASURY_ADDRESS=0x... node scripts/crypto-preflight.js
//  or pass them as args:
//    node scripts/crypto-preflight.js <rpcUrl> <treasuryAddress>
// ============================================================================
require('dotenv').config();
const { ethers } = require('ethers');

(async () => {
  const rpcUrl    = process.argv[2] || process.env.BASE_RPC_URL;
  const treasury  = process.argv[3] || process.env.TREASURY_ADDRESS;
  const usdcAddr  = process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const wantChain = Number(process.env.BASE_CHAIN_ID || 84532);

  if (!rpcUrl || !treasury) {
    console.error('Set BASE_RPC_URL and TREASURY_ADDRESS (env vars or two CLI args).');
    process.exit(1);
  }
  if (!ethers.isAddress(treasury)) {
    console.error('TREASURY_ADDRESS is not a valid address:', treasury);
    process.exit(1);
  }

  const mark = (ok) => (ok ? 'OK  ' : 'XX  ');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log('RPC URL                 ', String(rpcUrl).replace(/(\/v2\/)[^/]+/, '$1****'));
  console.log('Treasury                ', ethers.getAddress(treasury));

  const net = await provider.getNetwork();
  const chainOk = Number(net.chainId) === wantChain;
  console.log(mark(chainOk) + 'chainId                ' + Number(net.chainId) + (chainOk ? '' : `  (expected ${wantChain})`));

  const eth = await provider.getBalance(treasury);
  console.log(mark(eth > 0n) + 'treasury ETH (gas)     ' + ethers.formatEther(eth));

  const usdc = new ethers.Contract(usdcAddr, [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ], provider);
  const dec = await usdc.decimals();
  const bal = await usdc.balanceOf(treasury);
  console.log(mark(bal > 0n) + 'treasury USDC (payouts)' + '  ' + ethers.formatUnits(bal, dec));

  const allOk = chainOk && eth > 0n && bal > 0n;
  console.log('\n' + (allOk
    ? 'All good — safe to run a small end-to-end test.'
    : 'Fix the XX lines above first. ETH funds gas for withdrawals; USDC funds payouts.'));
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('Preflight failed:', e.message); process.exit(1); });
