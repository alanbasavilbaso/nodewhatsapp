import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import WhatsAppManager from './services/whatsappManager.js';
import logger from './utils/logger.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar manager de WhatsApp
const whatsappManager = new WhatsAppManager();

// Middleware básico
app.use(helmet());

// CORS simplificado - sin validaciones de origin
app.use(cors({
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Auth', 'User-Agent'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de autenticación simplificado - solo lo que importa
const authenticate = (req, res, next) => {
  //1. Validar User-Agent
  const userAgent = req.headers['user-agent'];
  const allowedUserAgents = process.env.ALLOWED_USER_AGENTS ? process.env.ALLOWED_USER_AGENTS.split(',') : ['SymfonyApp'];
  
  if (process.env.REQUIRE_USER_AGENT === 'true') {
    if (!userAgent || !allowedUserAgents.some(agent => userAgent.includes(agent))) {
      return res.status(403).json({ 
        error: 'Acceso no autorizado'
      });
    }
  }

  // 2. Validar Token de API - ✅ CORREGIDO
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
  try {
    const allSessions = whatsappManager.getAllInstances();
    const sessionCount = Object.keys(allSessions).length;
    
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      whatsapp: {
        totalSessions: sessionCount,
        sessions: allSessions
      },
      server: {
        memory: process.memoryUsage(),
        version: process.version,
        platform: process.platform
      }
    });
  } catch (error) {
    logger.error('Error en health check:', error);
    res.status(500).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: 'Error interno del servidor'
    });
  }
});

// 🔐 Endpoints CON autenticación
// Endpoint para obtener estado de una sesión específica
app.get('/api/whatsapp/session/:phoneNumber/status', authenticate, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const instance = await whatsappManager.getInstance(phoneNumber);
    const state = instance.getConnectionState();
    
    res.json({
      success: true,
      data: state
    });
  } catch (error) {
    logger.error('Error obteniendo estado:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Endpoint inteligente para obtener QR - maneja automáticamente la conexión
app.get('/api/whatsapp/session/:phoneNumber/qr', authenticate, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    
    // Intentar obtener la instancia existente
    let instance;
    let state;
    
    try {
      instance = await whatsappManager.getInstance(phoneNumber);
      state = instance.getConnectionState();
    } catch (error) {
      // Si no existe la instancia, se creará automáticamente
      logger.info(`Creando nueva instancia para ${phoneNumber}`);
      instance = await whatsappManager.getInstance(phoneNumber);
      state = instance.getConnectionState();
    }
    
    // Si ya está conectado, no necesita QR
    if (state.isConnected && state.state === 'connected') {
      return res.json({
        success: true,
        message: 'QR no disponible - Ya está conectado',
        state: 'connected',
        phoneNumber: phoneNumber
      });
    }
    
    // Si está desconectado o con error, forzar reconexión
    if (state.state === 'disconnected' || state.state === 'failed') {
      logger.info(`🔄 Forzando reconexión para ${phoneNumber} - Estado: ${state.state}`);
      
      // Cerrar instancia actual y crear nueva
      await whatsappManager.closeInstance(phoneNumber);
      instance = await whatsappManager.getInstance(phoneNumber);
      
      // Solicitar QR explícitamente
      instance.requestQRCode();
      
      // Esperar un momento para que se genere el QR
      await new Promise(resolve => setTimeout(resolve, 2000));
      state = instance.getConnectionState();
    } else {
      // Para otros estados, solicitar QR explícitamente
      instance.requestQRCode();
      
      // Esperar un momento para que se genere el QR si es necesario
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = instance.getConnectionState();
    }
    
    // Si hay QR disponible, devolverlo
    if (state.qrCode) {
      return res.json({
        success: true,
        message: 'QR disponible - Escanea para conectar',
        qrCode: state.qrCode,
        state: state.state,
        phoneNumber: phoneNumber,
        reconnectAttempts: state.reconnectAttempts,
        maxReconnectAttempts: state.maxReconnectAttempts
      });
    }
    
    // Si está conectando o reconectando, informar el estado
    if (state.state === 'connecting' || state.state === 'reconnecting') {
      return res.json({
        success: false,
        message: `Estado: ${state.state} - Intenta nuevamente en unos segundos`,
        state: state.state,
        phoneNumber: phoneNumber,
        reconnectAttempts: state.reconnectAttempts,
        maxReconnectAttempts: state.maxReconnectAttempts
      });
    }
    
    // Estado no disponible
    return res.json({
      success: false,
      message: 'QR no disponible en este momento',
      state: state.state,
      phoneNumber: phoneNumber,
      reconnectAttempts: state.reconnectAttempts,
      maxReconnectAttempts: state.maxReconnectAttempts
    });
    
  } catch (error) {
    logger.error('Error obteniendo QR:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Endpoint para enviar mensaje desde una sesión específica
app.post('/api/whatsapp/session/:phoneNumber/send-message', authenticate, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos: to, message'
      });
    }
    
    const instance = await whatsappManager.getInstance(phoneNumber);
    const result = await instance.sendMessage(to, message);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error enviando mensaje:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Nuevo endpoint para listar todas las sesiones
app.get('/api/whatsapp/sessions', authenticate, (req, res) => {
  try {
    const sessions = whatsappManager.getAllInstances();
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    logger.error('Error obteniendo sesiones:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Endpoint para cerrar una sesión específica
app.delete('/api/whatsapp/session/:phoneNumber', authenticate, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    await whatsappManager.closeInstance(phoneNumber);
    
    res.json({
      success: true,
      message: `Sesión ${phoneNumber} cerrada exitosamente`
    });
  } catch (error) {
    logger.error('Error cerrando sesión:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Endpoint para enviar templates de citas médicas
app.post('/api/whatsapp/session/:phoneNumber/send-template', authenticate, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { appointmentId, phone, messageType, appointmentData, confirmUrl, cancelUrl } = req.body;
    
    // Validar datos requeridos (confirmUrl y cancelUrl son opcionales)
    if (!appointmentId || !phone || !messageType || !appointmentData) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos: appointmentId, phone, messageType, appointmentData',
        appointmentId: appointmentId || null,
        phone: phone || null
      });
    }
    
    // Validar messageType
    const validMessageTypes = ['confirmation', 'reminder', 'urgent'];
    if (!validMessageTypes.includes(messageType)) {
      return res.status(400).json({
        success: false,
        error: `messageType debe ser uno de: ${validMessageTypes.join(', ')}`,
        appointmentId,
        phone
      });
    }
    
    // Validar appointmentData
    const requiredFields = ['patientName', 'serviceName', 'professionalName', 'date', 'time', 'duration', 'locationName', 'locationAddress'];
    const missingFields = requiredFields.filter(field => !appointmentData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Faltan campos en appointmentData: ${missingFields.join(', ')}`,
        appointmentId,
        phone
      });
    }
    
    // Obtener instancia de WhatsApp
    const instance = await whatsappManager.getInstance(phoneNumber);
    
    // Preparar datos del template (solo incluir URLs si están presentes)
    const templateData = {
      messageType,
      appointmentData
    };
    
    // Agregar URLs solo si están presentes
    if (confirmUrl) {
      templateData.confirmUrl = confirmUrl;
    }
    if (cancelUrl) {
      templateData.cancelUrl = cancelUrl;
    }
    
    // Enviar template
    const result = await instance.sendTemplate(phone, templateData);
    
    // Logging
    logger.info(`📋 Template enviado - ID: ${appointmentId}, Tipo: ${messageType}, Teléfono: ${phone}, Estado: éxito`);
    
    res.json({
      success: true,
      messageId: result.messageId,
      phone: phone,
      appointmentId: appointmentId,
      messageType: messageType,
      sentAt: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error(`❌ Error enviando template - ID: ${req.body?.appointmentId}, Teléfono: ${req.body?.phone}, Error:`, error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      appointmentId: req.body?.appointmentId || null,
      phone: req.body?.phone || null
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
    // Cargar instancias existentes - COMENTADO para evitar carga automática
    // await whatsappManager.loadExistingInstances();
    
    app.listen(PORT, () => {
      logger.info(`🚀 Servidor iniciado en puerto ${PORT}`);
    });
  } catch (error) {
    logger.error('Error iniciando servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
  logger.info('🔄 Cerrando servidor...');
  await whatsappManager.closeAllInstances();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('🔄 Cerrando servidor...');
  await whatsappManager.closeAllInstances();
  process.exit(0);
});

startServer();
