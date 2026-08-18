require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ====== CONFIGURACIÓN (viene de las variables de entorno, ver .env.example) ======
const {
  TELEGRAM_BOT_TOKEN,
  TRACKED_WALLET,
  SIM_SOL_PER_TRADE,
  HELIUS_WEBHOOK_SECRET,
  PORT,
  DAILY_SUMMARY_HOUR, // hora del día (0-23) para el resumen diario
} = process.env;

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || !TRACKED_WALLET || ALLOWED_USER_IDS.length === 0) {
  console.error('Faltan variables de entorno obligatorias: TELEGRAM_BOT_TOKEN, TRACKED_WALLET, ALLOWED_USER_IDS');
  process.exit(1);
}

const SIM_AMOUNT = parseFloat(SIM_SOL_PER_TRADE || '1');
const STATE_FILE = path.join(__dirname, 'state.json');

// ====== ESTADO PERSISTENTE (se guarda en un archivo JSON) ======
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { openPositions: {}, dailyTrades: [], totalSimPnl: 0 };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
let state = loadState();

// ====== BOT DE TELEGRAM ======
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function isAllowed(userId) {
  return ALLOWED_USER_IDS.includes(String(userId));
}

function broadcast(message) {
  ALLOWED_USER_IDS.forEach((chatId) => {
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch((err) =>
      console.error('Error enviando mensaje a', chatId, err.message)
    );
  });
}

function shortMint(mint) {
  return mint ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : 'desconocido';
}

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `🤖 *Bot de simulación activo*\n\nTrackeando wallet: \`${shortMint(TRACKED_WALLET)}\`\nMonto simulado por trade: *${SIM_AMOUNT} SOL*\n\nComandos:\n/status — ver posiciones abiertas y ganancia total simulada\n/pnl — resumen rápido de ganancia/pérdida acumulada`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const open = Object.entries(state.openPositions);
  let text = `📊 *Estado actual*\n\nPnL simulado acumulado: *${state.totalSimPnl.toFixed(4)} SOL*\n\n`;
  if (open.length === 0) {
    text += 'No hay posiciones abiertas ahora mismo.';
  } else {
    text += '*Posiciones abiertas:*\n';
    open.forEach(([mint, pos]) => {
      text += `• ${shortMint(mint)} — invertido: ${pos.simSolIn.toFixed(4)} SOL\n`;
    });
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/pnl/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `💰 PnL simulado acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`, {
    parse_mode: 'Markdown',
  });
});

// ====== SERVIDOR WEB (acá le pega Helius cada vez que la wallet trackeada hace un trade) ======
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  // seguridad simple: solo aceptamos webhooks que traigan el secreto que vos definiste
  const authHeader = req.headers['authorization'];
  if (HELIUS_WEBHOOK_SECRET && authHeader !== HELIUS_WEBHOOK_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  events.forEach(processTransaction);

  res.status(200).send('ok');
});

app.get('/', (_req, res) => res.send('Bot de simulación corriendo ✅'));

function processTransaction(tx) {
  try {
    const swap = tx?.events?.swap;
    if (!swap) return; // no es un swap, lo ignoramos

    const isBuy = !!swap.nativeInput && swap.tokenOutputs?.length > 0;
    const isSell = !!swap.nativeOutput && swap.tokenInputs?.length > 0;

    if (isBuy) {
      const realSol = Number(swap.nativeInput.amount) / 1e9;
      const token = swap.tokenOutputs[0];
      const realTokenAmount = Number(token.rawTokenAmount.tokenAmount) / 10 ** token.rawTokenAmount.decimals;
      handleBuy(token.mint, realSol, realTokenAmount);
    } else if (isSell) {
      const realSol = Number(swap.nativeOutput.amount) / 1e9;
      const token = swap.tokenInputs[0];
      const realTokenAmount = Number(token.rawTokenAmount.tokenAmount) / 10 ** token.rawTokenAmount.decimals;
      handleSell(token.mint, realSol, realTokenAmount);
    }
  } catch (err) {
    console.error('Error procesando transacción:', err.message);
  }
}

function handleBuy(mint, realSol, realTokenAmount) {
  const simSolIn = SIM_AMOUNT;
  const simTokenAmount = simSolIn * (realTokenAmount / realSol);

  const existing = state.openPositions[mint];
  if (existing) {
    existing.simSolIn += simSolIn;
    existing.simTokenAmount += simTokenAmount;
    existing.realTokenAmountBought += realTokenAmount;
  } else {
    state.openPositions[mint] = {
      simSolIn,
      simTokenAmount,
      realTokenAmountBought: realTokenAmount,
      firstBuyTime: Date.now(),
    };
  }

  const record = { type: 'buy', mint, simSolIn, timestamp: Date.now() };
  state.dailyTrades.push(record);
  saveState(state);

  broadcast(
    `🟢 *COMPRA simulada*\nToken: \`${shortMint(mint)}\`\nMonto simulado: *${simSolIn.toFixed(4)} SOL*\n(el trader puso ${realSol.toFixed(4)} SOL)`
  );
}

function handleSell(mint, realSol, realTokenAmount) {
  const position = state.openPositions[mint];
  if (!position) {
    // el trader vendió algo que no vimos comprar (lo tenía de antes) — no podemos simular esto
    return;
  }

  const fraction = Math.min(1, realTokenAmount / position.realTokenAmountBought);
  const simTokenAmountSold = position.simTokenAmount * fraction;
  const simSolInPortion = position.simSolIn * fraction;
  const simSolOut = simTokenAmountSold * (realSol / realTokenAmount);
  const pnlSim = simSolOut - simSolInPortion;

  position.simTokenAmount -= simTokenAmountSold;
  position.simSolIn -= simSolInPortion;
  position.realTokenAmountBought -= realTokenAmount;

  if (position.realTokenAmountBought <= 0.000001) {
    delete state.openPositions[mint];
  }

  state.totalSimPnl += pnlSim;

  const record = { type: 'sell', mint, simSolOut, pnlSim, timestamp: Date.now() };
  state.dailyTrades.push(record);
  saveState(state);

  const emoji = pnlSim >= 0 ? '✅' : '🔴';
  broadcast(
    `${emoji} *VENTA simulada*\nToken: \`${shortMint(mint)}\`\nResultado: *${pnlSim >= 0 ? '+' : ''}${pnlSim.toFixed(4)} SOL*\nPnL total acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`
  );
}

// ====== RESUMEN DIARIO ======
const summaryHour = parseInt(DAILY_SUMMARY_HOUR || '21', 10);
cron.schedule(`0 ${summaryHour} * * *`, () => {
  const trades = state.dailyTrades;
  const buys = trades.filter((t) => t.type === 'buy').length;
  const sells = trades.filter((t) => t.type === 'sell');
  const dayPnl = sells.reduce((acc, t) => acc + t.pnlSim, 0);

  let text = `📅 *Resumen del día*\n\nCompras simuladas: ${buys}\nVentas simuladas: ${sells.length}\nResultado del día: *${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(4)} SOL*\n\nPnL total acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`;

  if (trades.length === 0) {
    text = '📅 *Resumen del día*\n\nLa wallet trackeada no operó hoy.';
  }

  broadcast(text);
  state.dailyTrades = [];
  saveState(state);
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Bot escuchando en el puerto ${port}`);
  console.log(`Trackeando wallet: ${TRACKED_WALLET}`);
});
