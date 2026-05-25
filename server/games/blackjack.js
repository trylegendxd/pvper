// server/games/blackjack.js — single-player vs house.
// Server holds the deck. Client only sees its cards + dealer's visible card.
const { withTx, pool } = require('../db');
const { adjustBalance } = require('../wallet');
const { secureShuffle } = require('../rng');

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function newDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  return secureShuffle(cards);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { total += 11; aces++; }
    else if (['J','Q','K','10'].includes(c.r)) total += 10;
    else total += Number(c.r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

/** Public view (dealer hole card hidden while hand is active). */
function publicView(hand, hideDealerHole = true) {
  const dealer = hand.dealer_cards.slice();
  let dealerVisible = dealer;
  let dealerValue   = handValue(dealer);
  if (hideDealerHole && hand.status === 'active' && dealer.length >= 2) {
    dealerVisible = [dealer[0], { hidden: true }];
    dealerValue   = handValue([dealer[0]]);
  }
  return {
    id:           hand.id,
    bet:          Number(hand.bet_amount),
    playerCards:  hand.player_cards,
    dealerCards:  dealerVisible,
    playerValue:  handValue(hand.player_cards),
    dealerValue,
    status:       hand.status,
    outcome:      hand.outcome,
    payout:       Number(hand.payout || 0),
  };
}

// Hard cap so a single user can't open dozens of simultaneous hands.
const MAX_ACTIVE_HANDS = 3;

async function _startOne(client, userId, betAmount) {
  betAmount = Math.floor(Number(betAmount));
  if (!Number.isFinite(betAmount) || betAmount <= 0) throw new Error('invalid_bet_amount');

  const active = await client.query(
    `SELECT COUNT(*)::int AS n FROM blackjack_hands WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  if ((active.rows[0]?.n || 0) >= MAX_ACTIVE_HANDS) throw new Error('too_many_active_hands');

  const { rows: gs } = await client.query(
    `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
     VALUES ('blackjack','active',$1,$1)
     RETURNING id`,
    [betAmount]
  );
  const sessionId = gs[0].id;

  await adjustBalance(userId, -betAmount, 'bet', {
    refType: 'blackjack', refId: sessionId, client,
  });

  let deck = newDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];

  let status  = 'active';
  let outcome = null;
  let payout  = 0;

  if (isBlackjack(player)) {
    if (isBlackjack(dealer)) {
      status = 'push'; outcome = 'push'; payout = betAmount;
    } else {
      status = 'player_blackjack'; outcome = 'blackjack';
      payout = Math.floor(betAmount * 2.5);
    }
  }

  const { rows } = await client.query(
    `INSERT INTO blackjack_hands
       (session_id, user_id, bet_amount, deck, player_cards, dealer_cards, status, outcome, payout, finished_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9, CASE WHEN $7 = 'active' THEN NULL ELSE NOW() END)
     RETURNING *`,
    [sessionId, userId, betAmount,
     JSON.stringify(deck), JSON.stringify(player), JSON.stringify(dealer),
     status, outcome, payout]
  );
  const hand = rows[0];

  if (payout > 0) {
    const reason = outcome === 'push' ? 'refund' : 'blackjack_payout';
    await adjustBalance(userId, payout, reason, {
      refType: 'blackjack', refId: sessionId, client,
      metadata: { outcome },
    });
  }
  if (status !== 'active') {
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [sessionId]);
  }
  return publicView(hand, status === 'active');
}

/** Start a single hand (kept for backwards compatibility). */
async function start(userId, betAmount) {
  return withTx(async (client) => _startOne(client, userId, betAmount));
}

/** Start up to MAX_ACTIVE_HANDS hands atomically.
 *  bets: array of positive integers, length 1..MAX_ACTIVE_HANDS.
 *  If any bet fails (e.g. balance), the whole batch rolls back. */
async function startBatch(userId, bets) {
  if (!Array.isArray(bets) || bets.length === 0) throw new Error('invalid_bet_amount');
  if (bets.length > MAX_ACTIVE_HANDS) throw new Error('too_many_hands');
  return withTx(async (client) => {
    // Pre-check active count once so we fail fast with a clear error.
    const active = await client.query(
      `SELECT COUNT(*)::int AS n FROM blackjack_hands WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    if ((active.rows[0]?.n || 0) + bets.length > MAX_ACTIVE_HANDS) throw new Error('too_many_active_hands');

    const out = [];
    for (const b of bets) {
      out.push(await _startOne(client, userId, b));
    }
    return out;
  });
}

/** Double-down: doubles bet, takes exactly 1 card, stands automatically.
 *  Requires: hand is active, only 2 player cards so far, sufficient balance. */
async function doubleDown(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands
        WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');
    if (hand.player_cards.length !== 2) throw new Error('double_only_on_first_two');

    const extra = Number(hand.bet_amount);
    // Charge the extra bet
    await adjustBalance(userId, -extra, 'bet', {
      refType: 'blackjack', refId: hand.session_id + ':double', client,
    });

    // Take exactly one card
    const deck   = hand.deck.slice();
    const player = hand.player_cards.slice();
    player.push(deck.pop());

    const pv = handValue(player);
    let status, outcome, payout = 0;
    const newBet = Number(hand.bet_amount) * 2;

    if (pv > 21) {
      status = 'player_bust'; outcome = 'lose';
    } else {
      // Auto-stand: dealer plays
      const dealer = hand.dealer_cards.slice();
      while (handValue(dealer) < 17) dealer.push(deck.pop());
      const dv = handValue(dealer);
      if (dv > 21 || pv > dv)      { status = 'won';  outcome = 'win';  payout = newBet * 2; }
      else if (pv === dv)          { status = 'push'; outcome = 'push'; payout = newBet; }
      else                         { status = 'lost'; outcome = 'lose'; payout = 0; }

      await client.query(
        `UPDATE blackjack_hands
            SET deck=$1::jsonb, dealer_cards=$2::jsonb, player_cards=$3::jsonb,
                bet_amount=$4, status=$5, outcome=$6, payout=$7, finished_at=NOW()
          WHERE id=$8`,
        [JSON.stringify(deck), JSON.stringify(dealer), JSON.stringify(player),
         newBet, status, outcome, payout, handId]
      );
    }

    // Bust path: dealer never plays
    if (status === 'player_bust') {
      await client.query(
        `UPDATE blackjack_hands
            SET deck=$1::jsonb, player_cards=$2::jsonb, bet_amount=$3,
                status=$4, outcome=$5, payout=$6, finished_at=NOW()
          WHERE id=$7`,
        [JSON.stringify(deck), JSON.stringify(player), newBet, status, outcome, payout, handId]
      );
    }

    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW(), bet_amount=$1 WHERE id=$2`,
                       [newBet, hand.session_id]);

    if (payout > 0) {
      const reason = outcome === 'push' ? 'refund' : 'blackjack_payout';
      await adjustBalance(userId, payout, reason, {
        refType: 'blackjack', refId: hand.session_id + ':doublepay', client,
        metadata: { outcome, doubled: true },
      });
    }

    const fresh = (await client.query('SELECT * FROM blackjack_hands WHERE id=$1', [handId])).rows[0];
    return publicView(fresh, false);
  });
}

/** Player hits. */
async function hit(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands
        WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');

    const deck   = hand.deck.slice();
    const player = hand.player_cards.slice();
    player.push(deck.pop());

    const pv = handValue(player);
    let status = 'active', outcome = null, payout = 0;
    if (pv > 21) { status = 'player_bust'; outcome = 'lose'; }

    await client.query(
      `UPDATE blackjack_hands
          SET deck=$1::jsonb, player_cards=$2::jsonb, status=$3, outcome=$4, payout=$5,
              finished_at = CASE WHEN $3 = 'active' THEN NULL ELSE NOW() END
        WHERE id=$6`,
      [JSON.stringify(deck), JSON.stringify(player), status, outcome, payout, handId]
    );

    if (status !== 'active') {
      await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [hand.session_id]);
    }

    const fresh = (await client.query('SELECT * FROM blackjack_hands WHERE id=$1', [handId])).rows[0];
    return publicView(fresh, status === 'active');
  });
}

/** Player stands → dealer plays → resolve. */
async function stand(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands
        WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');

    const deck   = hand.deck.slice();
    const dealer = hand.dealer_cards.slice();

    while (handValue(dealer) < 17) dealer.push(deck.pop());

    const pv = handValue(hand.player_cards);
    const dv = handValue(dealer);

    let status, outcome, payout = 0;
    const bet = Number(hand.bet_amount);
    if (dv > 21 || pv > dv) {
      status = 'won'; outcome = 'win'; payout = bet * 2;
    } else if (pv === dv) {
      status = 'push'; outcome = 'push'; payout = bet;
    } else {
      status = 'lost'; outcome = 'lose'; payout = 0;
    }

    await client.query(
      `UPDATE blackjack_hands
          SET deck=$1::jsonb, dealer_cards=$2::jsonb, status=$3, outcome=$4, payout=$5, finished_at=NOW()
        WHERE id=$6`,
      [JSON.stringify(deck), JSON.stringify(dealer), status, outcome, payout, handId]
    );
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [hand.session_id]);

    if (payout > 0) {
      const reason = outcome === 'push' ? 'refund' : 'blackjack_payout';
      await adjustBalance(userId, payout, reason, {
        refType: 'blackjack', refId: hand.session_id, client,
        metadata: { outcome, dv, pv },
      });
    }

    const fresh = (await client.query('SELECT * FROM blackjack_hands WHERE id=$1', [handId])).rows[0];
    return publicView(fresh, false);
  });
}

/** Returns ALL active hands for the user (newest first), up to MAX_ACTIVE_HANDS. */
async function getActive(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM blackjack_hands
      WHERE user_id = $1 AND status = 'active'
   ORDER BY created_at ASC
      LIMIT $2`,
    [userId, MAX_ACTIVE_HANDS]
  );
  return rows.map(r => publicView(r, true));
}

module.exports = { start, startBatch, hit, stand, doubleDown, getActive, MAX_ACTIVE_HANDS };
