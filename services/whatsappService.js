const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const logger = require('../utils/logger');

function createBaileysLogger() {
  return {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => createBaileysLogger()
  };
}

class WhatsAppService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionState = 'disconnected';
    this.qrCode = null;
    this.phoneNumber = '+542346505040'; // Número fijo
    this.authDir = './auth_info_baileys_542346505040';
  }

  async initialize() {
    try {
      logger.info('🚀 Inicializando WhatsApp Service...');
      
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      
      logger.info(`Baileys v${version.join('.')}, es la última: ${isLatest}`);

      this.client = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: createBaileysLogger(),
        browser: ['WhatsApp Service', 'Chrome', '1.0.0']
      });

      this.setupEventHandlers(saveCreds);
      
      logger.info('✅ WhatsApp Service inicializado');
    } catch (error) {
      logger.error('Error inicializando WhatsApp Service:', error);
      throw error;
    }
  }

  setupEventHandlers(saveCreds) {
    this.client.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        this.generateQRCode(qr);
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          logger.info('🔄 Reconectando...');
          this.connectionState = 'reconnecting';
          this.isConnected = false;
          setTimeout(() => this.initialize(), 3000);
        } else {
          logger.info('❌ Conexión cerrada permanentemente');
          this.connectionState = 'disconnected';
          this.isConnected = false;
        }
      } else if (connection === 'open') {
        logger.info('✅ WhatsApp conectado exitosamente');
        this.isConnected = true;
        this.connectionState = 'connected';
        this.qrCode = null;
      }
    });

    this.client.ev.on('creds.update', saveCreds);
  }

  async generateQRCode(qr) {
    try {
      this.connectionState = 'qr_ready';
      this.qrCode = await QRCode.toDataURL(qr);
      logger.info('📱 Código QR generado');
    } catch (error) {
      logger.error('Error generando QR:', error);
      this.qrCode = qr; // Fallback al string
    }
  }

  async sendMessage(to, message) {
    if (!this.isConnected) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      
      if (typeof message === 'string') {
        await this.client.sendMessage(jid, { text: message });
      } else if (message.type === 'image') {
        await this.client.sendMessage(jid, {
          image: { url: message.url },
          caption: message.caption || ''
        });
      } else if (message.type === 'document') {
        await this.client.sendMessage(jid, {
          document: { url: message.url },
          fileName: message.fileName || 'document',
          mimetype: message.mimetype || 'application/octet-stream'
        });
      }
      
      logger.info(`📤 Mensaje enviado a ${to}`);
      return { success: true };
    } catch (error) {
      logger.error('Error enviando mensaje:', error);
      throw error;
    }
  }

  getConnectionState() {
    return {
      isConnected: this.isConnected,
      state: this.connectionState,
      qrCode: this.qrCode,
      phoneNumber: this.phoneNumber
    };
  }

  async gracefulShutdown() {
    if (this.client) {
      logger.info('🔄 Cerrando conexión WhatsApp...');
      // NO destruir la sesión, solo cerrar la conexión
      this.client.end();
      this.client = null;
      this.isConnected = false;
      this.connectionState = 'disconnected';
    }
  }
}

module.exports = WhatsAppService;