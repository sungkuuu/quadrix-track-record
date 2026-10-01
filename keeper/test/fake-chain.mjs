/**
 * Test helper (no network): a tiny model of one QuadrixBasketVault v3.1 and
 * its mock tokens behind a viem-shaped public client and wallet, with a node
 * that can LAG — after each mined transaction the next `lagReads` reads are
 * answered by a node one block behind, in turn:
 *   'stale'    — a read at `latest` gets the state before the transaction;
 *                a read at the new block errors "header not found";
 *   'empty'    — eth_call answers "0x" (viem: returned no data);
 *   'notfound' — every read errors "header not found" / BlockNotFound.
 * Only what keeper/basket-recon.mjs and keeper/set-bidder.mjs call is modelled.
 */
import { encodeEventTopics, encodeAbiParameters, getAddress, keccak256, toHex, maxUint256, BlockNotFoundError } from 'viem';
import { VAULT_ABI } from '../basket-plan.mjs';

export const ZERO32 = `0x${'0'.repeat(64)}`;
const EVENTS = [...VAULT_ABI.filter((x) => x.type === 'event'), { type: 'event', name: 'AuctionCancelled', inputs: [{ type: 'uint256', name: 'id', indexed: true }] }];

const clone = (s) => structuredClone(s);
const lc = (a) => String(a).toLowerCase();

function rpcError(details) {
  const e = new Error(`RPC Request failed.\n\nDetails: ${details}`);
  e.shortMessage = 'RPC Request failed.';
  e.details = details;
  return e;
}
function zeroData(fn) {
  const e = new Error(`The contract function "${fn}" returned no data ("0x").`);
  e.shortMessage = e.message;
  e.name = 'ContractFunctionZeroDataError';
  return e;
}
function revert(reason) {
  const e = new Error(`The contract function reverted with the following reason:\n${reason}`);
  e.shortMessage = `reverted: ${reason}`;
  e.cause = { name: 'ContractFunctionRevertedError', reason, data: { errorName: reason } };
  return e;
}

export class FakeChain {
  constructor({ vault, owner, keeper = owner, assets = [], t0 = 1_790_000_000n, startBlock = 1000n } = {}) {
    this.vault = getAddress(vault);
    this.blocks = []; // [{ number, timestamp, state, txs }]
    this.receipts = new Map();
    this.txs = new Map();
    this.logs = [];
    this.lagReads = 0;     // armed after each mined tx
    this.lagLeft = 0;
    this.lagCycle = 0;
    this.lagModes = ['stale', 'empty', 'notfound'];
    this.neverHas = null;  // a block number this node never serves (getBlock / pinned reads)
    this.receiptFails = 0; // waitForTransactionReceipt throws this many times
    this.receiptHidden = new Set(); // hashes whose receipt is "not found"
    this.reads = 0;
    this.sent = [];
    this.timeOffset = 0n;
    const state = {
      owner: getAddress(owner), keeper: getAddress(keeper), registry: [], inRemoval: {}, refPrice: {}, refAt: {},
      balances: {}, decimals: {}, symbols: {}, faucet: {}, pending: ZERO32, eta: 0n, auctions: [], biddingOpen: false, bidders: {},
      premiumBps: 200n, maxFillLossBps: 100n, maxRefAge: 3600n, registryDelay: 604800n, shares: { [lc(owner)]: 10n ** 21n },
    };
    for (const a of assets) this.addToken(state, a);
    this.blocks.push({ number: startBlock, timestamp: t0, state, txs: [] });
  }

  addToken(state, { address, symbol, decimals, balance = 0n, ref = 0n, faucet = 10n ** 6n, registry = false }, reg = registry) {
    const a = getAddress(address);
    state.decimals[lc(a)] = decimals;
    state.symbols[lc(a)] = symbol;
    state.faucet[lc(a)] = faucet;
    state.balances[lc(a)] = { [lc(this.vault)]: balance };
    if (reg) { state.registry.push(a); state.refPrice[lc(a)] = ref; state.refAt[lc(a)] = ref ? this.blocks[0]?.timestamp ?? 1_790_000_000n : 0n; }
  }

  get head() { return this.blocks[this.blocks.length - 1]; }
  block(n) { return this.blocks.find((b) => b.number === BigInt(n)); }
  state(n) { return n == null ? this.head.state : this.block(n)?.state; }

  /** Mine one block applying `fn(state)`; returns the new block. */
  mine(fn = () => {}, { dt = 1n } = {}) {
    const st = clone(this.head.state);
    const ts = this.head.timestamp + dt + this.timeOffset;
    this.timeOffset = 0n;
    const blk = { number: this.head.number + 1n, timestamp: ts, state: st, txs: [] };
    const logs = fn(st, blk) ?? [];
    this.blocks.push(blk);
    return { blk, logs };
  }

  // -------------------------------------------------------------- the node
  /** Which node answers this read: 'ok' or a lag mode. */
  nodeFor() {
    this.reads++;
    if (this.lagLeft > 0) {
      this.lagLeft--;
      return this.lagModes[this.lagCycle++ % this.lagModes.length];
    }
    return 'ok';
  }
  /** The block a read is evaluated at, or throws as a lagging node would. */
  at(blockNumber, mode, fn = 'call') {
    const visible = mode === 'ok' ? this.head.number : this.head.number - 1n;
    if (blockNumber != null && this.neverHas != null && BigInt(blockNumber) >= this.neverHas) throw rpcError('header not found');
    if (mode === 'notfound') throw rpcError('header not found');
    if (mode === 'empty') throw zeroData(fn);
    if (blockNumber == null) return this.block(visible);
    if (BigInt(blockNumber) > visible) throw rpcError('header not found');
    return this.block(blockNumber);
  }

  read({ address, functionName, args = [] }, st, blk) {
    const a = lc(address);
    if (a === lc(this.vault)) {
      const x = args[0] != null ? lc(args[0]) : null;
      switch (functionName) {
        case 'owner': return st.owner;
        case 'keeper': return st.keeper;
        case 'assetCount': return BigInt(st.registry.length);
        case 'assets': return st.registry[Number(args[0])];
        case 'isRegistryAsset': return st.registry.some((r) => lc(r) === x);
        case 'inRemoval': return !!st.inRemoval[x];
        case 'refPrice': return st.refPrice[x] ?? 0n;
        case 'refPriceUpdatedAt': return st.refAt[x] ?? 0n;
        case 'navPerShare': return 10n ** 18n;
        case 'totalSupply': return 10n ** 21n;
        case 'balanceOf': return st.shares[x] ?? 0n;
        case 'pendingRegistryChange': return st.pending;
        case 'pendingRegistryEta': return st.eta;
        case 'maxRefAge': return st.maxRefAge;
        case 'maxFillLossBps': return st.maxFillLossBps;
        case 'dailyLossBudgetBps': return 50n;
        case 'biddingOpen': return st.biddingOpen;
        case 'isBidder': return !!st.bidders[x];
        case 'auctionCount': return BigInt(st.auctions.length);
        case 'auctions': { const u = st.auctions[Number(args[0])]; return [u.sell, u.buy, u.remaining, u.start, u.duration, u.open]; }
        case 'curveFactorBps': { const u = st.auctions[Number(args[0])]; const e = blk.timestamp - u.start; if (e > u.duration) throw revert('AuctionExpired'); return 10_000n + st.premiumBps - ((st.premiumBps + st.maxFillLossBps) * e) / u.duration; }
        case 'CURVE_START_PREMIUM_BPS': return st.premiumBps;
        case 'REGISTRY_DELAY': return st.registryDelay;
        default: throw new Error(`fake vault: no view ${functionName}`);
      }
    }
    if (!(a in st.decimals)) throw zeroData(functionName);
    switch (functionName) {
      case 'decimals': return st.decimals[a];
      case 'symbol': return st.symbols[a];
      case 'balanceOf': return st.balances[a][lc(args[0])] ?? 0n;
      case 'allowance': return maxUint256;
      case 'faucetAmount': return st.faucet[a];
      default: throw new Error(`fake token: no view ${functionName}`);
    }
  }

  // ------------------------------------------------------- transactions
  tupleHash(adds, removes, sha) {
    return keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }, { type: 'bytes32' }], [adds, removes, sha]));
  }
  log(eventName, args, address = this.vault) {
    const ev = EVENTS.find((x) => x.name === eventName);
    const topics = encodeEventTopics({ abi: [ev], eventName, args });
    const nonIdx = ev.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIdx, nonIdx.map((i) => args[i.name]));
    return { address: getAddress(address), topics, data };
  }
  /** Apply a call to `st`; returns logs; throws revert(...) like the contract. */
  apply(st, blk, from, { address, functionName, args = [] }) {
    const a = lc(address);
    const f = getAddress(from);
    if (a !== lc(this.vault)) {
      if (functionName === 'faucet') { st.balances[a][lc(f)] = (st.balances[a][lc(f)] ?? 0n) + st.faucet[a]; return []; }
      if (functionName === 'approve') return [];
      throw revert(`token ${functionName}`);
    }
    const isReg = (x) => st.registry.some((r) => lc(r) === lc(x));
    switch (functionName) {
      case 'announceRegistryChange': {
        if (f !== st.owner) throw revert('OwnableUnauthorizedAccount');
        const [adds, removes, sha] = args;
        for (const x of adds) if (isReg(x)) throw revert('AlreadyRegistryAsset');
        for (const x of removes) { if (!isReg(x)) throw revert('NotRegistryAsset'); if (st.inRemoval[lc(x)]) throw revert('AssetInRemoval'); }
        st.pending = this.tupleHash(adds, removes, sha);
        st.eta = blk.timestamp + st.registryDelay;
        return [this.log('RegistryChangeAnnounced', { adds, removes, decisionSha256: sha, eta: st.eta })];
      }
      case 'executeRegistryChange': {
        const [adds, removes, sha] = args;
        if (st.pending === ZERO32) throw revert('NoPendingChange');
        if (blk.timestamp < st.eta) throw revert('TimelockNotElapsed');
        if (this.tupleHash(adds, removes, sha) !== st.pending) throw revert('ChangeMismatch');
        st.pending = ZERO32; st.eta = 0n;
        for (const x of adds) { st.registry.push(getAddress(x)); st.refPrice[lc(x)] = 0n; st.refAt[lc(x)] = 0n; }
        for (const x of removes) st.inRemoval[lc(x)] = true;
        return [this.log('RegistryChangeExecuted', { adds, removes, decisionSha256: sha })];
      }
      case 'setRefPrice': {
        if (f !== st.keeper) throw revert('NotKeeper');
        const [x, p] = args;
        if (!isReg(x)) throw revert('NotRegistryAsset');
        const old = st.refPrice[lc(x)] ?? 0n;
        if (old !== 0n) { const span = (old * 1500n) / 10_000n; if (p > old + span || p < old - span) throw revert('NavMoveTooLarge'); }
        st.refPrice[lc(x)] = p; st.refAt[lc(x)] = blk.timestamp;
        return [this.log('RefPricePosted', { asset: x, price: p })];
      }
      case 'openAuction': {
        if (f !== st.keeper) throw revert('NotKeeper');
        const [sell, buy, amount, duration] = args;
        const id = BigInt(st.auctions.length);
        st.auctions.push({ sell: getAddress(sell), buy: getAddress(buy), remaining: amount, start: blk.timestamp, duration: BigInt(duration), open: true });
        return [this.log('AuctionOpened', { id, sellAsset: sell, buyAsset: buy, sellAmount: amount, duration: BigInt(duration) })];
      }
      case 'cancelAuction': {
        if (f !== st.keeper) throw revert('NotKeeper');
        st.auctions[Number(args[0])].open = false;
        return [this.log('AuctionCancelled', { id: args[0] })];
      }
      case 'fill': {
        const [id, take] = args;
        const u = st.auctions[Number(id)];
        if (!st.biddingOpen && !st.bidders[lc(f)]) throw revert('NotBidder');
        if (!u.open) throw revert('AuctionClosed');
        if (take > u.remaining) throw revert('CapExceeded');
        const factor = this.read({ address: this.vault, functionName: 'curveFactorBps', args: [id] }, st, blk);
        const pS = st.refPrice[lc(u.sell)]; const pB = st.refPrice[lc(u.buy)];
        const pay = (take * pS * factor + pB * 10_000n - 1n) / (pB * 10_000n);
        u.remaining -= take; if (u.remaining === 0n) u.open = false;
        const v = lc(this.vault);
        st.balances[lc(u.sell)][v] -= take;
        st.balances[lc(u.sell)][lc(f)] = (st.balances[lc(u.sell)][lc(f)] ?? 0n) + take;
        st.balances[lc(u.buy)][lc(f)] = (st.balances[lc(u.buy)][lc(f)] ?? 0n) - pay;
        st.balances[lc(u.buy)][v] = (st.balances[lc(u.buy)][v] ?? 0n) + pay;
        const loss = pay * pB >= take * pS ? 0n : take * pS - pay * pB;
        return [this.log('AuctionFilled', { id, bidder: f, sellTaken: take, buyPaid: pay, lossAtRef: loss })];
      }
      case 'setBidder': {
        if (f !== st.owner) throw revert('OwnableUnauthorizedAccount');
        st.bidders[lc(args[0])] = !!args[1];
        return []; // v3.1's owner setters emit no event (RT24)
      }
      case 'finalizeRemoval': {
        const [x] = args;
        if (!st.inRemoval[lc(x)]) throw revert('NotInRemoval');
        if ((st.balances[lc(x)][lc(this.vault)] ?? 0n) !== 0n) throw revert('RemovalNotDrained');
        const i = st.registry.findIndex((r) => lc(r) === lc(x));
        st.registry[i] = st.registry[st.registry.length - 1]; st.registry.pop();
        delete st.inRemoval[lc(x)]; delete st.refPrice[lc(x)]; delete st.refAt[lc(x)];
        return [this.log('RemovalFinalized', { asset: x })];
      }
      default: throw revert(`fake vault: no function ${functionName}`);
    }
  }

  /** Send as `from` without the client (an "earlier run" or a third party). */
  send(from, call) {
    const hash = keccak256(toHex(`tx-${this.sent.length}-${call.functionName}-${Math.random()}`));
    let logs; let status = 'success';
    const { blk } = this.mine((st, b) => {
      try { logs = this.apply(st, b, from, call); } catch { status = 'reverted'; logs = []; }
      return logs;
    });
    blk.txs.push(hash);
    const withMeta = logs.map((l, i) => ({ ...l, blockNumber: blk.number, transactionHash: hash, logIndex: this.logs.length + i, blockHash: keccak256(toHex(`b${blk.number}`)), transactionIndex: 0, removed: false }));
    this.logs.push(...withMeta);
    const receipt = { transactionHash: hash, blockNumber: blk.number, status, gasUsed: 50_000n, logs: withMeta, from: getAddress(from), to: getAddress(call.address) };
    this.receipts.set(lc(hash), receipt);
    this.txs.set(lc(hash), { hash, from: getAddress(from), to: getAddress(call.address), blockNumber: blk.number, input: call });
    this.sent.push({ hash, from: getAddress(from), to: getAddress(call.address), functionName: call.functionName, args: call.args ?? [], gas: call.gas });
    this.lagLeft = this.lagReads;
    return { hash, receipt };
  }

  // ---------------------------------------------------- viem-shaped client
  client() {
    const self = this;
    const pc = {
      async getChainId() { return 91342; },
      async getBlockNumber() { const m = self.nodeFor(); return m === 'ok' ? self.head.number : self.head.number - 1n; },
      async getBlock(args = {}) {
        const m = self.nodeFor();
        const n = args.blockNumber;
        if (n != null && self.neverHas != null && BigInt(n) >= self.neverHas) throw new BlockNotFoundError({ blockNumber: BigInt(n) });
        const visible = m === 'ok' ? self.head.number : self.head.number - 1n;
        if (n != null && (BigInt(n) > visible || m === 'notfound' || m === 'empty')) throw new BlockNotFoundError({ blockNumber: BigInt(n) });
        const b = n != null ? self.block(n) : self.block(visible);
        return { number: b.number, timestamp: b.timestamp, hash: keccak256(toHex(`b${b.number}`)) };
      },
      async readContract(c) {
        const m = self.nodeFor();
        const b = self.at(c.blockNumber, m, c.functionName);
        return self.read(c, b.state, b);
      },
      async multicall({ contracts, blockNumber }) {
        const m = self.nodeFor();
        const b = self.at(blockNumber, m, 'aggregate3');
        return contracts.map((c) => self.read(c, b.state, b));
      },
      async simulateContract(p) {
        const m = self.nodeFor();
        const b = self.at(p.blockNumber, m, p.functionName);
        const st = clone(b.state);
        const sim = { number: b.number + 1n, timestamp: b.timestamp + 1n };
        self.apply(st, sim, p.account, p);
        return { request: { abi: p.abi, address: p.address, args: p.args, functionName: p.functionName, account: p.account, ...(p.blockNumber != null ? { blockNumber: p.blockNumber } : {}) }, result: undefined };
      },
      async waitForTransactionReceipt({ hash }) {
        if (self.receiptFails > 0) { self.receiptFails--; throw new Error('Timed out while waiting for transaction'); }
        const r = self.receipts.get(lc(hash));
        if (!r) throw new Error(`fake: no receipt ${hash}`);
        return r;
      },
      async getTransactionReceipt({ hash }) {
        if (self.receiptHidden.has(lc(hash))) { const e = new Error(`Transaction receipt with hash "${hash}" could not be found.`); e.name = 'TransactionReceiptNotFoundError'; throw e; }
        const r = self.receipts.get(lc(hash));
        if (!r) { const e = new Error(`Transaction receipt with hash "${hash}" could not be found.`); e.name = 'TransactionReceiptNotFoundError'; throw e; }
        return r;
      },
      async getTransaction({ hash }) { const t = self.txs.get(lc(hash)); if (!t) throw new Error('tx not found'); return t; },
      async getLogs({ address, fromBlock, toBlock, event }) {
        const lo = BigInt(fromBlock); const hi = BigInt(toBlock);
        let out = self.logs.filter((l) => lc(l.address) === lc(address) && l.blockNumber >= lo && l.blockNumber <= hi);
        if (event) {
          const { parseEventLogs } = await import('viem');
          out = parseEventLogs({ abi: [event], logs: out });
        }
        return out;
      },
      async request({ method, params }) {
        if (method === 'evm_increaseTime') { self.timeOffset += BigInt(params[0]); return '0x0'; }
        if (method === 'evm_mine') { self.mine(); return '0x0'; }
        if (method === 'web3_clientVersion') return 'fake/1.0';
        throw new Error(`fake: no ${method}`);
      },
    };
    return pc;
  }

  wallet(account) {
    const self = this;
    return {
      account: getAddress(account),
      async writeContract(req) {
        if (req.blockNumber != null) throw new Error('fake wallet: a blockNumber reached writeContract');
        return self.send(account, req).hash;
      },
    };
  }

  reader() {
    const pc = this.client();
    async function batch(contracts) {
      const out = [];
      // the plain reader: one Multicall3 call at latest
      return pc.multicall({ contracts }).then((r) => { out.push(...r); return out; });
    }
    return { publicClient: pc, batch, hasMulticall: true, pace: 0, rpc: 'fake', chainId: 91342 };
  }
}
