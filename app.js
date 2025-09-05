const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const WhatsAppService = require('./services/whatsappService');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar servicio de WhatsApp
const whatsappService = new WhatsAppService();

// Middleware básico
app.use(helmet());

// Configuración CORS más específica
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:8000'];
    
    // Permitir requests sin origin (como Postman) en desarrollo
    if (!origin && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Auth', 'Origin', 'User-Agent'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de autenticación simple (deshabilitado para desarrollo)
// Middleware de autenticación con validaciones completas
const authenticate = (req, res, next) => {
  // 1. Validar Origin
  const origin = req.headers['origin'];
  const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:8000'];
  
  if (!origin || !allowedOrigins.includes(origin)) {
    return res.status(403).json({ 
      error: 'Origin no permitido',
      required: 'Origin debe ser uno de: ' + allowedOrigins.join(', ')
    });
  }

  // 2. Validar User-Agent
  const userAgent = req.headers['user-agent'];
  const allowedUserAgents = process.env.ALLOWED_USER_AGENTS ? process.env.ALLOWED_USER_AGENTS.split(',') : ['SymfonyApp'];
  
  if (process.env.REQUIRE_USER_AGENT === 'true') {
    if (!userAgent || !allowedUserAgents.some(agent => userAgent.includes(agent))) {
      return res.status(403).json({ 
        error: 'User-Agent no permitido',
        required: 'User-Agent debe contener uno de: ' + allowedUserAgents.join(', ')
      });
    }
  }

  // 3. Validar Token de API - ✅ CORREGIDO
  const apiToken = req.headers['x-api-auth'];
  
  // Seleccionar token según el entorno
  let validToken;
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  switch (nodeEnv) {
    case 'production':
      validToken = process.env.PROD_ACCESS_TOKEN || process.env.RAILWAY_ACCESS_TOKEN;
      break;
    case 'development':
    case 'dev':
      validToken = process.env.LOCAL_ACCESS_TOKEN || 'dev_token_12345';
      break;
    case 'symfony':
      validToken = process.env.SYMFONY_ACCESS_TOKEN;
      break;
    default:
      validToken = process.env.LOCAL_ACCESS_TOKEN || 'dev_token_12345';
  }
  
  if (!validToken) {
    return res.status(500).json({ 
      error: 'Configuración de token no encontrada para el entorno: ' + nodeEnv
    });
  }
  
  if (!apiToken || apiToken !== validToken) {
    return res.status(401).json({ 
      error: 'Token de autenticación requerido',
      required: 'Header X-API-Auth con token válido para entorno: ' + nodeEnv,
      environment: nodeEnv
    });
  }

  next(); // Todas las validaciones pasaron
};

// 🟢 Endpoint de salud SIN autenticación
app.get('/api/health', (req, res) => {
  const status = whatsappService.getConnectionState();
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    whatsapp: status
  });
});

// 🔐 Endpoints CON autenticación
app.get('/api/whatsapp/session/:phoneNumber/status', authenticate, (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  // Validar que sea el número correcto
  if (phoneNumber !== '542346505040') {
    return res.status(400).json({ error: 'Número de teléfono no válido' });
  }
  
  const status = whatsappService.getConnectionState();
  res.json({
    phoneNumber: `+${phoneNumber}`,
    ...status
  });
});

// Cambiar esta línea en el endpoint QR (línea 66 aproximadamente):
app.get('/api/whatsapp/session/:phoneNumber/qr', authenticate, (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  if (phoneNumber !== '542346505040') {
    return res.status(400).json({ error: 'Número de teléfono no válido' });
  }
  
  // Cambiar de whatsappService.getQRCode() a:
  const connectionState = whatsappService.getConnectionState();
  const qrCode = connectionState.qrCode;
  
  if (!qrCode) {
    return res.status(404).json({ 
      error: 'QR no disponible', 
      state: connectionState.state,
      message: 'El QR se genera automáticamente al inicializar. Espera unos segundos e intenta de nuevo.' 
    });
  }
  
  res.json({ 
    qrCode, 
    phoneNumber: `+${phoneNumber}`,
    state: connectionState.state
  });
});

app.post('/api/whatsapp/session/:phoneNumber/send-message', authenticate, async (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  if (phoneNumber !== '542346505040') {
    return res.status(400).json({ error: 'Número de teléfono no válido' });
  }
  
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Campos "to" y "message" son requeridos'
      });
    }
    
    const result = await whatsappService.sendMessage(to, message);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Manejo de errores
app.use((err, req, res, next) => {
  logger.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Iniciar servidor
async function startServer() {
  try {
    await whatsappService.initialize();
    
    app.listen(PORT, () => {
      logger.info(`🚀 Servidor iniciado en puerto ${PORT}`);
      logger.info(`📱 WhatsApp Service para +542346505040`);
      logger.info(`🔑 Usa: Authorization: Bearer ${process.env.API_TOKEN || 'mi-token-secreto-2024'}`);
    });
  } catch (error) {
    logger.error('Error iniciando servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
  logger.info('🔄 Cerrando servidor...');
  await whatsappService.gracefulShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('🔄 Cerrando servidor...');
  await whatsappService.gracefulShutdown();
  process.exit(0);
});

startServer();
