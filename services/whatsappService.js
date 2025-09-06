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
  constructor(phoneNumber, authDir) {
    this.client = null;
    this.isConnected = false;
    this.connectionState = 'disconnected';
    this.qrCode = null;
    this.phoneNumber = phoneNumber;
    this.authDir = authDir;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async initialize() {
    try {
      logger.info(`🚀 Inicializando WhatsApp Service para ${this.phoneNumber}...`);
      
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      
      logger.info(`Baileys v${version.join('.')}, es la última: ${isLatest}`);

      this.client = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: createBaileysLogger(),
        browser: [`WhatsApp Service ${this.phoneNumber}`, 'Chrome', '1.0.0']
      });

      this.setupEventHandlers(saveCreds);
      
      logger.info(`✅ WhatsApp Service inicializado para ${this.phoneNumber}`);
    } catch (error) {
      logger.error(`Error inicializando WhatsApp Service para ${this.phoneNumber}:`, error);
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
        
        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          logger.info(`🔄 Reconectando ${this.phoneNumber} (intento ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          this.connectionState = 'reconnecting';
          this.isConnected = false;
          setTimeout(() => this.initialize(), 3000 * this.reconnectAttempts);
        } else {
          logger.info(`❌ Conexión cerrada permanentemente para ${this.phoneNumber}`);
          this.connectionState = 'disconnected';
          this.isConnected = false;
          this.reconnectAttempts = 0;
        }
      } else if (connection === 'open') {
        logger.info(`✅ WhatsApp conectado exitosamente para ${this.phoneNumber}`);
        this.isConnected = true;
        this.connectionState = 'connected';
        this.qrCode = null;
        this.reconnectAttempts = 0;
      }
    });

    this.client.ev.on('creds.update', saveCreds);
  }

  async generateQRCode(qr) {
    try {
      this.connectionState = 'qr_ready';
      this.qrCode = await QRCode.toDataURL(qr);
      logger.info(`📱 Código QR generado para ${this.phoneNumber}`);
    } catch (error) {
      logger.error(`Error generando QR para ${this.phoneNumber}:`, error);
      this.qrCode = qr;
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

  async sendTemplate(to, templateData) {
    if (!this.isConnected) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      const message = this.generateTemplateMessage(templateData);
      
      // Enviar mensaje con formato avanzado
      await this.client.sendMessage(jid, {
        text: message,
        contextInfo: {
          forwardingScore: 1,
          isForwarded: false
        }
      });
      
      logger.info(`📤 Template enviado a ${to} - Tipo: ${templateData.messageType}`);
      return { 
        success: true, 
        messageId: `whatsapp_msg_${Date.now()}`,
        messageType: templateData.messageType
      };
    } catch (error) {
      logger.error('Error enviando template:', error);
      throw error;
    }
  }

  generateTemplateMessage(data) {
    const { messageType, appointmentData, confirmUrl, cancelUrl } = data;
    const formattedDate = this.formatAppointmentDate(appointmentData.date);
    
    switch (messageType) {
      case 'confirmation':
        return this.generateConfirmationMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
      case 'reminder':
        return this.generateReminderMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
      case 'urgent':
        return this.generateUrgentMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
      default:
        throw new Error(`Tipo de mensaje no válido: ${messageType}`);
    }
  }

  formatAppointmentDate(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 
                       'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    
    const dayName = dayNames[date.getDay()];
    const day = date.getDate();
    const month = monthNames[date.getMonth()];
    
    if (date.toDateString() === today.toDateString()) {
      return `HOY - ${dayName} ${day} de ${month}`;
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return `MAÑANA - ${dayName} ${day} de ${month}`;
    } else {
      return `${dayName} ${day} de ${month}`;
    }
  }

  generateConfirmationMessage(data, formattedDate, confirmUrl, cancelUrl) {
        return `✅ *TURNO CONFIRMADO*
    ━━━━━━━━━━━━━━━━━━━━━

    👤 *Paciente:* ${data.patientName}
    🏥 *Servicio:* ${data.serviceName}
    👨‍⚕️ *Profesional:* ${data.professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${data.time}
    ⏱️ *Duración:* ${data.duration}
    📍 *Lugar:* ${data.locationName}
    🗺️ *Dirección:* ${data.locationAddress}

    ━━━━━━━━━━━━━━━━━━━━━
    💡 *¿Necesitas hacer cambios?*

    🟢 *CONFIRMAR TU TURNO:*
    ${confirmUrl}

    🔴 *CANCELAR TU TURNO:*
    ${cancelUrl}

    ⚠️ _Los enlaces expiran en 24 horas_
    _Toca el enlace para abrir en tu navegador_`;
  }

  generateReminderMessage(data, formattedDate, confirmUrl, cancelUrl) {
    return `⏰ *RECORDATORIO DE TURNO*
    ━━━━━━━━━━━━━━━━━━━━━

    ¡Hola ${data.patientName}! 👋
    Te recordamos tu próximo turno:

    🏥 *Servicio:* ${data.serviceName}
    👨‍⚕️ *Profesional:* ${data.professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${data.time} hs
    📍 *Lugar:* ${data.locationName}
    🗺️ *Dirección:* ${data.locationAddress}

    ━━━━━━━━━━━━━━━━━━━━━
    💡 *Gestiona tu turno:*

    ✅ Confirmar: ${confirmUrl}
    ❌ Cancelar: ${cancelUrl}

    📞 _Si tienes dudas, contacta a la clínica_`;
  }

  generateUrgentMessage(data, formattedDate, confirmUrl, cancelUrl) {
    return `🚨 *MENSAJE URGENTE*
    ━━━━━━━━━━━━━━━━━━━━━

    ⚠️ *ATENCIÓN ${data.patientName}*

    Tu turno de *HOY* requiere confirmación inmediata:

    🏥 *Servicio:* ${data.serviceName}
    👨‍⚕️ *Profesional:* ${data.professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${data.time} hs
    📍 *Lugar:* ${data.locationName}

    ━━━━━━━━━━━━━━━━━━━━━
    🔥 *ACCIÓN REQUERIDA:*

    ✅ Confirmar: ${confirmUrl}
    ❌ Cancelar: ${cancelUrl}

    ⏰ _Confirma antes de las 12:00 hs_`;
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