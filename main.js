// main.js - Backend KumoWave Lofi (Busca COMBINADA aprimorada)

// Dependências e módulos
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { JsonDatabase } = require('wio.db');
const axios = require('axios');       // Para RapidAPI
const ytSearch = require('yt-search'); // Biblioteca de busca 1
const ytstream = require('yt-stream'); // Biblioteca de busca 2

// --- Configurações ---
const app = express();
const PORT = process.env.PORT || 3000;
const db = new JsonDatabase({ databasePath: "./databases/kumowave.json" });

// --- Constantes ---
const LOFI_CHANNEL_NAME = 'Lofi Everyday'; // Nome exato do canal alvo
const LOFI_CHANNEL_NAME_NORMALIZED = LOFI_CHANNEL_NAME.toLowerCase().replace(/\s/g, ''); // Para comparação mais robusta
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "195d9d56f0mshf2ef5b15de50facp11ef65jsn7dbd159005d4"; // Use variável de ambiente ou fallback (INSEGURO)
const RAPIDAPI_HOST = "yt-api.p.rapidapi.com";
const SEARCH_QUERIES = [
  `${LOFI_CHANNEL_NAME} live radio`,
  `${LOFI_CHANNEL_NAME} live stream`,
  `${LOFI_CHANNEL_NAME} 24/7`,
  LOFI_CHANNEL_NAME
];
const YT_SEARCH_PAGES = 1; // Páginas para yt-search
const YT_STREAM_LIMIT = 10; // Limite para yt-stream
const WALLPAPERS_DEFAULT = [ 
  "https://iili.io/37mp2x1.jpg", "https://iili.io/37pMMjs.jpg", "https://iili.io/37pMVZG.jpg",
  "https://iili.io/37pMhG4.png", "https://iili.io/37pMj6l.png", "https://iili.io/37pMOaS.jpg",
  "https://iili.io/37pMe87.jpg", "https://iili.io/37pMv99.jpg", "https://iili.io/37pMSwu.jpg",
  "https://iili.io/37pMUZb.jpg", "https://iili.io/37pM4Mx.png", "https://iili.io/37ydV2e.jpg"
];
const STREAM_EXPIRATION_MS = 3 * 60 * 60 * 1000; // 3 horas
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

// --- Estado Global ---
let currentStream = { videoId: null, title: null, startedAt: null, listeners: 0, audioUrl: null };
let playedVideos = [];

// --- Middlewares ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// --- Logger Simplificado ---
const log = {
  info: (message) => console.log(`[INFO] ${message}`),
  warn: (message) => console.warn(`[WARN] ${message}`),
  error: (message, error = null) => console.error(`[ERROR] ${message}`, error || ''),
  debug: (message) => { /* console.log(`[DEBUG] ${message}`) */ }
};

/**
 * Função para normalizar strings: remove espaços e converte para minúsculas.
 */
function normalize(str) {
  return str.toLowerCase().replace(/\s/g, '');
}

/**
 * Busca vídeos no YouTube usando yt-search E yt-stream,
 * filtrando pelo NOME DO CANAL de forma mais robusta.
 */
async function searchLofiVideos() {
  log.info(`Iniciando busca COMBINADA (yt-search & yt-stream) por vídeos de '${LOFI_CHANNEL_NAME}'...`);
  const uniqueVideos = {}; // Objeto para guardar resultados únicos (ID -> videoInfo)

  // --- Busca com yt-search ---
  try {
    log.debug("Iniciando busca com yt-search...");
    let ytSearchFoundCount = 0;
    for (const query of SEARCH_QUERIES) {
      try {
        const result = await ytSearch({ query: query, pages: YT_SEARCH_PAGES });
        const videos = result.videos || [];
        log.debug(`yt-search query "${query}" encontrou ${videos.length} vídeos.`);
        for (const video of videos) {
          if (video.author && video.author.name && normalize(video.author.name).includes(LOFI_CHANNEL_NAME_NORMALIZED)) {
            if (!uniqueVideos[video.videoId]) { // Adiciona se for do canal e inédito
              const isLive = (video.duration && typeof video.duration === "object") 
                              ? video.duration.timestamp?.toLowerCase() === 'live'
                              : (video.duration === 'Live' || video.duration === 'live');
              const durationSeconds = video.duration && video.duration.seconds ? video.duration.seconds : 0;
              uniqueVideos[video.videoId] = {
                videoId: video.videoId,
                title: video.title,
                author: { name: video.author.name },
                isLive: isLive || (durationSeconds === 0 && video.duration?.timestamp !== '0:00'),
                duration: { seconds: durationSeconds },
                timestamp: video.duration?.timestamp || 'Unknown',
                source: 'yt-search'
              };
              ytSearchFoundCount++;
            }
          }
        }
      } catch (queryError) {
        log.warn(`Falha na query yt-search "${query}": ${queryError.message}`);
      }
    }
    log.info(`Busca yt-search concluída. ${ytSearchFoundCount} vídeos do canal encontrados.`);
  } catch (error) {
    log.error("Erro geral durante a busca com yt-search.", error);
  }

  // --- Busca com yt-stream ---
  let ytStreamFoundCount = 0;
  const searchOptionsYtStream = { limit: YT_STREAM_LIMIT, type: "video" };
  try {
    log.debug("Iniciando busca com yt-stream...");
    for (const query of SEARCH_QUERIES) {
      try {
        const results = await ytstream.search(query, searchOptionsYtStream);
        log.debug(`yt-stream query "${query}" encontrou ${results.length} vídeos.`);
        for (const video of results) {
          if (video.author && video.author.name && normalize(video.author.name).includes(LOFI_CHANNEL_NAME_NORMALIZED)) {
            if (!uniqueVideos[video.id]) { // Adiciona se for do canal e inédito
              let durationSeconds = 0;
              const isLive = video.is_live ?? false;
              if (video.duration && !isLive) {
                const parts = String(video.duration).split(':').map(Number);
                if (parts.length === 3)
                  durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                else if (parts.length === 2)
                  durationSeconds = parts[0] * 60 + parts[1];
                else if (parts.length === 1)
                  durationSeconds = parts[0];
              }
              uniqueVideos[video.id] = {
                videoId: video.id,
                title: video.title,
                author: { name: video.author.name },
                isLive: isLive,
                duration: { seconds: durationSeconds },
                timestamp: video.duration || (isLive ? 'Live' : 'Unknown'),
                source: 'yt-stream'
              };
              ytStreamFoundCount++;
            }
          }
        }
      } catch (queryError) {
        log.warn(`Falha na query yt-stream "${query}": ${queryError?.message}`);
      }
    }
    log.info(`Busca yt-stream concluída. ${ytStreamFoundCount} vídeos *adicionais* do canal encontrados.`);
  } catch (error) {
    log.error("Erro geral durante a busca com yt-stream.", error);
  }

  // --- Finalização ---
  const formattedVideos = Object.values(uniqueVideos);
  log.info(`Busca combinada concluída. ${formattedVideos.length} vídeos únicos totais encontrados para '${LOFI_CHANNEL_NAME}'.`);

  if (formattedVideos.length === 0) {
    return { allVideos: [], liveVideos: [], longVideos: [] };
  }

  // Separa lives/rádios (baseado no campo 'isLive')
  const liveCandidates = formattedVideos.filter(video => video.isLive);
  const longVideos = formattedVideos.filter(video => video.duration.seconds > 10800 && !video.isLive); // > 3h

  log.info(`Identificados ${liveCandidates.length} lives/rádios e ${longVideos.length} vídeos longos (>3h).`);
  return { allVideos: formattedVideos, liveVideos: liveCandidates, longVideos };
}

/** 
 * Função que busca e seleciona um vídeo, depois obtém a URL de stream via RapidAPI.
 */
async function fetchNewLofiStream() {
  let selectedVideo = null;
  try {
    log.info("Buscando nova stream...");
    // Chama a função de busca COMBINADA aprimorada
    const { allVideos, liveVideos, longVideos } = await searchLofiVideos();

    // --- Lógica de Seleção Refinada ---
    const availableLives = liveVideos.filter(v => !playedVideos.includes(v.videoId));
    const availableLongs = longVideos.filter(v => !playedVideos.includes(v.videoId));
    const availableOthers = allVideos.filter(v =>
      !liveVideos.some(lv => lv.videoId === v.videoId) &&
      !longVideos.some(lg => lg.videoId === v.videoId) &&
      !playedVideos.includes(v.videoId)
    );

    if (availableLives.length > 0) {
      selectedVideo = availableLives[0]; // Pega a primeira live disponível
      log.info(`Selecionada live prioritária: "${selectedVideo.title}" (ID: ${selectedVideo.videoId})`);
    } else if (availableLongs.length > 0) {
      selectedVideo = availableLongs[Math.floor(Math.random() * availableLongs.length)];
      log.info(`Nenhuma live nova. Selecionado vídeo longo: "${selectedVideo.title}" (ID: ${selectedVideo.videoId})`);
    } else if (availableOthers.length > 0) {
      selectedVideo = availableOthers[Math.floor(Math.random() * availableOthers.length)];
      log.warn(`Nenhuma live/vídeo longo novo. Selecionado outro vídeo: "${selectedVideo.title}" (ID: ${selectedVideo.videoId})`);
    } else {
      log.warn("Nenhum vídeo novo encontrado. Tentando reutilizar um antigo...");
      const reusable = allVideos.filter(v => v.videoId !== currentStream.videoId);
      if (reusable.length > 0) {
        selectedVideo = reusable[Math.floor(Math.random() * reusable.length)];
        log.warn(`Reutilizando vídeo: "${selectedVideo.title}" (ID: ${selectedVideo.videoId})`);
      } else if (allVideos.length > 0) {
        selectedVideo = allVideos[0];
        log.warn(`Reutilizando o único vídeo encontrado: "${selectedVideo.title}" (ID: ${selectedVideo.videoId})`);
      } else {
        log.error("Nenhum vídeo encontrado após busca combinada. Impossível obter stream.");
        if (!currentStream?.audioUrl) {
          currentStream = { videoId: null, title: "Erro: Nenhum vídeo encontrado", startedAt: new Date(), listeners: 0, audioUrl: null };
          db.set("currentStream", currentStream);
        } else {
          currentStream.title = "Erro: Nenhum vídeo encontrado";
          db.set("currentStream", currentStream);
        }
        return currentStream;
      }
    }

    // --- Busca de URL com RapidAPI ---
    log.info(`Buscando URL da RapidAPI para "${selectedVideo.title}" (ID: ${selectedVideo.videoId})...`);
    const options = {
      method: 'GET',
      url: `https://${RAPIDAPI_HOST}/dl`,
      params: { id: selectedVideo.videoId },
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
      timeout: 25000
    };
    let audioUrl = null;
    try {
      const response = await axios.request(options);
      log.debug(`RapidAPI Status: ${response.status}`);
      if (response.data?.formats?.length > 0) {
        const audioFormat = response.data.formats.find(f => f.url && f.mimeType?.startsWith('audio/'));
        const anyFormat = response.data.formats.find(f => f.url);
        if (audioFormat?.url) {
          audioUrl = audioFormat.url;
          log.info(`URL de áudio obtida da RapidAPI.`);
          log.debug(`URL: ${audioUrl.substring(0, 70)}...`);
        } else if (anyFormat?.url) {
          audioUrl = anyFormat.url;
          log.warn(`URL de áudio não encontrada, usando formato ${anyFormat.mimeType || 'desconhecido'}.`);
          log.debug(`URL: ${audioUrl.substring(0, 70)}...`);
        } else {
          throw new Error("Nenhum formato com URL válida retornado pela RapidAPI.");
        }
      } else {
        throw new Error("Resposta da RapidAPI inválida ou sem formatos.");
      }
    } catch (error) {
      log.error(`Falha ao obter URL da RapidAPI para ID ${selectedVideo.videoId}.`, error?.message);
      if (error.response) { log.error(`RapidAPI Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`); }
      else if (error.request) { log.error("RapidAPI não respondeu."); }
      else { log.error("Erro na configuração da requisição Axios."); }
      if (!currentStream?.audioUrl) {
        currentStream = { videoId: selectedVideo.videoId, title: `Erro: Falha API Stream (${selectedVideo.title})`, startedAt: new Date(), listeners: 0, audioUrl: null };
        db.set("currentStream", currentStream);
      } else {
        currentStream.title = `Erro: Falha API Stream (${selectedVideo.title})`;
        db.set("currentStream", currentStream);
      }
      throw new Error("Falha na comunicação com a API de stream.");
    }

    // --- Atualiza Estado com Sucesso ---
    currentStream = {
      videoId: selectedVideo.videoId,
      title: selectedVideo.title,
      startedAt: new Date(),
      listeners: Math.floor(Math.random() * 500) + 50,
      audioUrl: audioUrl
    };
    if (!playedVideos.includes(currentStream.videoId)) {
      playedVideos.push(currentStream.videoId);
      if (playedVideos.length > 30) playedVideos.shift();
    }
    db.set("currentStream", currentStream);
    db.set("playedVideos", playedVideos);
    log.info(`Stream atualizada para: "${currentStream.title}" (URL OK)`);
    return currentStream;

  } catch (error) {
    log.error("Erro final no fetchNewLofiStream.", error?.message);
    return currentStream;
  }
}

// --- Funções initDatabase e updateListeners ---
async function initDatabase() {
  try {
    log.info("Inicializando banco de dados e stream...");
    playedVideos = db.has("playedVideos") ? db.get("playedVideos") : [];
    db.set("playedVideos", playedVideos);
    if (!db.has("wallpapers")) db.set("wallpapers", WALLPAPERS_DEFAULT);
    const savedStream = db.has("currentStream") ? db.get("currentStream") : null;
    const streamAge = savedStream?.startedAt ? (Date.now() - new Date(savedStream.startedAt).getTime()) : Infinity;
    if (savedStream && savedStream.audioUrl && streamAge < STREAM_EXPIRATION_MS) {
      log.info(`Usando stream salva: "${savedStream.title}" (${Math.round(streamAge / 60000)} min atrás).`);
      currentStream = savedStream;
    } else {
      if (savedStream) log.info("Stream salva expirada ou inválida. Buscando nova...");
      else log.info("Nenhuma stream salva. Buscando inicial...");
      await fetchNewLofiStream();
    }
    if (!currentStream.audioUrl) {
      log.error("Falha ao obter URL de áudio na inicialização.");
    }
    log.info(`Inicialização completa. Stream: "${currentStream.title || 'N/A'}" (URL ${currentStream.audioUrl ? 'OK' : 'NÃO DISPONÍVEL'})`);
  } catch (error) {
    log.error("Erro crítico durante initDatabase.", error);
    if (!currentStream.audioUrl) await fetchNewLofiStream();
  }
}
function updateListeners() {
  if (currentStream && currentStream.audioUrl) {
    const change = Math.floor(Math.random() * 15) - 7;
    currentStream.listeners = Math.max(20, (currentStream.listeners || 50) + change);
  } else {
    currentStream.listeners = 0;
  }
  log.debug(`Listeners atualizados para: ${currentStream.listeners}`);
}

// --- Rotas HTTP e Endpoints da API ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/stream', (req, res) => res.sendFile(path.join(__dirname, 'stream.html')));
app.get('/api/stream', async (req, res) => {
  try {
    const streamAge = currentStream.startedAt ? (Date.now() - new Date(currentStream.startedAt).getTime()) : Infinity;
    if (!currentStream.audioUrl || streamAge > STREAM_EXPIRATION_MS) {
      log.info(`/api/stream: Stream inválida ou expirada (${Math.round(streamAge / 60000)} min). Buscando nova...`);
      await fetchNewLofiStream();
    }
    const hasAudio = !!currentStream.audioUrl;
    log.info(`/api/stream: Respondendo com status da stream "${currentStream.title || 'N/A'}". HasAudio: ${hasAudio}`);
    res.json({ videoId: currentStream.videoId, title: currentStream.title || "Stream indisponível", listeners: hasAudio ? currentStream.listeners : 0, hasAudioUrl: hasAudio });
  } catch (error) {
    log.error("Erro em /api/stream.", error?.message);
    res.status(500).json({ error: "Erro interno", message: error?.message || 'Unknown error', hasAudioUrl: false });
  }
});
app.get('/api/audiostream', async (req, res) => {
  try {
    const streamAge = currentStream.startedAt ? (Date.now() - new Date(currentStream.startedAt).getTime()) : Infinity;
    if (!currentStream.audioUrl || streamAge > STREAM_EXPIRATION_MS) {
      log.warn(`/api/audiostream: URL inválida ou expirada. Buscando nova antes de redirecionar...`);
      await fetchNewLofiStream();
    }
    if (!currentStream.audioUrl) {
      log.error("/api/audiostream: Falha ao obter URL válida para redirecionamento.");
      return res.status(503).send("Stream temporariamente indisponível.");
    }
    log.info(`/api/audiostream: Redirecionando para URL do stream ID ${currentStream.videoId}...`);
    res.redirect(302, currentStream.audioUrl);
  } catch (error) {
    log.error("Erro em /api/audiostream.", error?.message);
    res.status(500).send("Erro interno ao processar o redirecionamento.");
  }
});
app.get('/api/refresh', async (req, res) => {
  log.info("Recebida solicitação para /api/refresh...");
  try {
    await fetchNewLofiStream();
    const hasAudio = !!currentStream.audioUrl;
    res.json({
      success: true,
      message: hasAudio ? "Nova stream buscada." : "Tentativa de busca concluída, stream indisponível.",
      currentStream: { videoId: currentStream.videoId, title: currentStream.title, listeners: hasAudio ? currentStream.listeners : 0, hasAudioUrl: hasAudio }
    });
  } catch (error) {
    log.error("Erro em /api/refresh.", error?.message);
    res.status(500).json({ success: false, error: "Erro durante o refresh", message: error?.message || 'Unknown error' });
  }
});
app.get('/api/wallpapers', (req, res) => {
  log.debug("Solicitação para /api/wallpapers");
  try {
    const savedWallpapers = WALLPAPERS_DEFAULT;/* db.has("wallpapers") ? db.get("wallpapers") : */
    res.json({ wallpapers: savedWallpapers });
  } catch (error) {
    log.error("Erro em /api/wallpapers.", error?.message);
    res.status(500).json({ error: "Erro ao buscar wallpapers", message: error?.message || 'Unknown error' });
  }
});
app.get('/api/stats', (req, res) => {
  log.debug("Solicitação para /api/stats");
  const hasAudio = !!currentStream.audioUrl;
  res.json({
    currentStream: { videoId: currentStream.videoId, title: currentStream.title, listeners: hasAudio ? currentStream.listeners : 0, startedAt: currentStream.startedAt, hasAudioUrl: hasAudio },
    playedCount: playedVideos.length
  });
});

// --- Inicialização do Servidor ---
async function startServer() {
  try {
    await initDatabase();
    setInterval(updateListeners, 60000);
    setInterval(async () => {
      const streamAge = currentStream.startedAt ? (Date.now() - new Date(currentStream.startedAt).getTime()) : Infinity;
      if (!currentStream.audioUrl || streamAge > REFRESH_INTERVAL_MS) {
        log.info(`Verificação periódica: Stream ${!currentStream.audioUrl ? 'inválida' : 'expirando'} (${Math.round(streamAge / 60000)} min). Buscando nova...`);
        await fetchNewLofiStream();
      } else {
        log.info(`Verificação periódica: Stream OK (${Math.round(streamAge / 60000)} min).`);
      }
    }, REFRESH_INTERVAL_MS);
    app.listen(PORT, () => {
      log.info(`Servidor KumoWave Lofi iniciado em http://localhost:${PORT}`);
    });
  } catch (error) {
    log.error("Erro fatal ao iniciar o servidor.", error);
    process.exit(1);
  }
}

// Inicia tudo!
startServer();