import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import logger from '../utils/logger.js';

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
  constructor(phoneNumber, authDir, manager = null) {
    this.client = null;
    this.isConnected = false;
    this.connectionState = 'disconnected';
    this.qrCode = null;
    this.phoneNumber = phoneNumber;
    this.authDir = authDir;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.manager = manager;
    this.isBusinessAccount = false; // Nueva propiedad para detectar cuenta business
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
        browser: [`TurnoBoost`, 'Chrome', '1.0.0']
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
        const disconnectReason = (lastDisconnect?.error)?.output?.statusCode;
        
        if (disconnectReason === DisconnectReason.loggedOut) {
          // Sesión cerrada desde el celular - eliminar completamente
          logger.info(`🗑️ Sesión cerrada desde el celular para ${this.phoneNumber} - Eliminando datos`);
          this.connectionState = 'logged_out';
          this.isConnected = false;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          this.isBusinessAccount = false; // Reset business status
          
          // Notificar al manager para que elimine esta instancia completamente
          if (this.manager) {
            this.manager.removeInstanceCompletely(this.phoneNumber);
          }
        } else {
          // Para cualquier otra desconexión, simplemente marcar como desconectado
          // NO reconectar automáticamente
          logger.info(`❌ Conexión cerrada para ${this.phoneNumber} - Razón: ${disconnectReason}`);
          this.connectionState = 'disconnected';
          this.isConnected = false;
          this.qrCode = null;
          this.isBusinessAccount = false; // Reset business status
          // No resetear reconnectAttempts para mantener el historial
        }
      } else if (connection === 'open') {
        logger.info(`✅ WhatsApp conectado exitosamente para ${this.phoneNumber}`);
        this.isConnected = true;
        this.connectionState = 'connected';
        this.qrCode = null;
        this.reconnectAttempts = 0;
        
        // Detectar si es cuenta business
        this.detectBusinessAccount();
      } else if (connection === 'connecting') {
        logger.info(`🔄 Conectando ${this.phoneNumber}...`);
        this.connectionState = 'connecting';
        this.isConnected = false;
      }
    });

    this.client.ev.on('creds.update', saveCreds);
  }

  // Nuevo método para detectar cuenta business
  detectBusinessAccount() {
    try {
      if (this.client && this.client.user) {
        // Verificar si tiene información de business
        const user = this.client.user;
        this.isBusinessAccount = !!(user.verifiedName || user.businessProfile || user.isBusiness);
        
        logger.info(`📊 Cuenta ${this.phoneNumber} - Business: ${this.isBusinessAccount ? 'Sí' : 'No'}`);
      }
    } catch (error) {
      logger.warn(`⚠️ No se pudo detectar tipo de cuenta para ${this.phoneNumber}:`, error.message);
      this.isBusinessAccount = false;
    }
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
      phoneNumber: this.phoneNumber,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      lastUpdate: new Date().toISOString(),
      needsQR: this.connectionState === 'qr_ready' && this.qrCode !== null,
      canConnect: !this.isConnected && this.connectionState !== 'connecting',
      isBusinessAccount: this.isBusinessAccount // Incluir información de business
    };
  }

  async waitForConnection(timeout = 30000) {
    return new Promise((resolve, reject) => {
      // Si ya está conectado, resolver inmediatamente
      if (this.isConnected) {
        return resolve();
      }
      
      // Si está en estado de error, rechazar inmediatamente
      if (this.connectionState === 'error' || this.connectionState === 'logged_out') {
        return reject(new Error(`No se puede conectar: ${this.connectionState}`));
      }
      
      const startTime = Date.now();
      
      const checkConnection = () => {
        if (this.isConnected) {
          return resolve();
        }
        
        if (this.connectionState === 'error' || this.connectionState === 'logged_out') {
          return reject(new Error(`No se puede conectar: ${this.connectionState}`));
        }
        
        if (Date.now() - startTime > timeout) {
          return reject(new Error('Timeout esperando conexión'));
        }
        
        // Verificar cada 500ms
        setTimeout(checkConnection, 500);
      };
      
      checkConnection();
    });
  }

  async sendMessage(to, message) {
    // Esperar hasta que esté conectado o falle
    await this.waitForConnection();
    
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
      
      // Notificar error al servidor
      await this.notifyError({
        type: 'message_send_error',
        phone: to,
        messageType: typeof message === 'string' ? 'text' : message.type,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code || 'unknown'
        },
        context: {
          isBusinessAccount: this.isBusinessAccount,
          connectionState: this.connectionState
        }
      });
      
      throw error;
    }
  }

  // Método para notificar errores al servidor
  async notifyError(errorData) {
    const notificationUrl = process.env.ERROR_NOTIFICATION_URL;
    const notificationKey = process.env.ERROR_NOTIFICATION_KEY;
    
    // Si no está configurado, solo hacer log local
    if (!notificationUrl || !notificationKey) {
      logger.warn('⚠️ Notificación de errores no configurada - solo log local');
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      service: 'whatsapp-service',
      phoneNumber: this.phoneNumber,
      ...errorData
    };

    // Intentar enviar notificación con retry
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(notificationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${notificationKey}`,
            'User-Agent': 'WhatsApp-Service/1.0'
          },
          body: JSON.stringify(payload),
          timeout: 5000 // 5 segundos timeout
        });

        if (response.ok) {
          logger.info(`📧 Notificación de error enviada exitosamente (intento ${attempt})`);
          return;
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (error) {
        logger.warn(`⚠️ Error enviando notificación (intento ${attempt}/3):`, error.message);
        
        if (attempt === 3) {
          logger.error('❌ Falló el envío de notificación después de 3 intentos');
        } else {
          // Esperar antes del siguiente intento (backoff exponencial)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }
  }

  async sendTemplate(to, templateData) {
    await this.waitForConnection();
    
    if (!this.isConnected) {
      throw new Error('WhatsApp no está conectado');
    }

    try {
      // Formatear el número de teléfono correctamente
      const jid = this.formatPhoneNumber(to);
      
      const message = this.generateTemplateMessage(templateData);
      
      // Si es cuenta business y el mensaje tiene botones, intentar enviar con botones
      if (this.isBusinessAccount && typeof message === 'object' && message.templateButtons) {
        try {
          const result = await this.client.sendMessage(jid, {
            text: message.text,
            templateButtons: message.templateButtons
          });
          
          logger.info(`📤 Template con botones enviado a ${to}`);
          return { success: true, messageId: result.key.id };
        } catch (buttonError) {
          logger.warn(`⚠️ Error enviando botones, enviando texto plano:`, buttonError.message);
          // Fallback a texto plano
          const fallbackMessage = this.generateFallbackMessage(templateData);
          const result = await this.client.sendMessage(jid, { text: fallbackMessage });
          logger.info(`📤 Template (fallback) enviado a ${to}`);
          return { success: true, messageId: result.key.id };
        }
      } else {
        // Para cuentas no business o mensajes sin botones, enviar como texto
        const textMessage = typeof message === 'object' ? message.text : message;
        const result = await this.client.sendMessage(jid, { text: textMessage });
        logger.info(`📤 Template enviado a ${to}`);
        return { success: true, messageId: result.key.id };
      }
    } catch (error) {
      logger.error(`❌ Error enviando template a ${to}:`, error);
      
      // Notificar error al servidor
      await this.notifyError({
        type: 'template_send_error',
        appointmentId: templateData.appointmentData?.appointmentId || 'unknown',
        phone: to,
        messageType: templateData.messageType,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code || 'unknown'
        },
        context: {
          isBusinessAccount: this.isBusinessAccount,
          connectionState: this.connectionState,
          hasButtons: typeof message === 'object' && message.templateButtons ? true : false
        }
      });
      
      throw error;
    }
  }

  // Método auxiliar para formatear números de teléfono
  formatPhoneNumber(phoneNumber) {
    // Si ya tiene el formato de WhatsApp, devolverlo tal como está
    if (phoneNumber.includes('@')) {
      return phoneNumber;
    }
    
    // Limpiar el número (solo dígitos)
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    // Validar que el número tenga al menos 10 dígitos
    if (cleanNumber.length < 10) {
      throw new Error(`Número de teléfono inválido: ${phoneNumber}`);
    }
    
    // Agregar el sufijo de WhatsApp
    return `${cleanNumber}@s.whatsapp.net`;
  }

  // Método para generar mensaje de fallback (texto plano)
  generateFallbackMessage(templateData) {
    const { messageType, appointmentData, confirmUrl, cancelUrl } = templateData;
    const formattedDate = this.formatAppointmentDate(appointmentData.date);
    
    switch (messageType) {
      case 'reminder':
        return this.generateReminderMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
      case 'urgent':
        return this.generateUrgentMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
      default: // confirmation
        return this.generateConfirmationMessage(appointmentData, formattedDate, confirmUrl, cancelUrl);
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
    const { professionalName, patientName, serviceName, locationName, time, locationAddress } = data;
    
    const baseMessage = `✅ *TURNO CONFIRMADO*

    👤 *Paciente:* ${patientName}
    ✨ *Servicio:* ${serviceName}
    👨‍⚕️ *Profesional:* ${professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${time} hs
    📍 *Lugar:* ${locationName}
    🗺️ *Dirección:* ${locationAddress}

    Por favor, confirme su asistencia al turno.`;

    // Si es cuenta business y hay URLs, crear botones
    if (this.isBusinessAccount && (confirmUrl || cancelUrl)) {
      const templateButtons = [];
      
      if (confirmUrl) {
        templateButtons.push({
          index: 1,
          urlButton: {
            displayText: '✅ Confirmar Turno',
            url: confirmUrl
          }
        });
      }
      
      if (cancelUrl) {
        templateButtons.push({
          index: templateButtons.length + 1,
          urlButton: {
            displayText: '❌ Cancelar Turno',
            url: cancelUrl
          }
        });
      }
      
      return {
        text: baseMessage,
        templateButtons: templateButtons
      };
    }
    
    // Para cuentas no business o sin URLs, devolver solo texto
    let textMessage = baseMessage;
    if (confirmUrl || cancelUrl) {
      textMessage += '\n\n📱 *Opciones:*';
      if (confirmUrl) textMessage += `\n✅ Confirmar Turno: ${confirmUrl}`;
      if (cancelUrl) textMessage += `\n❌ Cancelar Turno: ${cancelUrl}`;
    }
    
    return textMessage;
  }

  generateReminderMessage(data, formattedDate, confirmUrl, cancelUrl) {
    const { professionalName, patientName, serviceName, locationName, time, locationAddress } = data;
    
    const baseMessage = `⏰ *RECORDATORIO DE TURNO*
    ━━━━━━━━━━━━━━━━━━━━━

    ¡Hola ${patientName}! 👋
    Te recordamos tu próximo turno:

    🏥 *Servicio:* ${serviceName}
    👨‍⚕️ *Profesional:* ${professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${time} hs
    📍 *Lugar:* ${locationName}
    🗺️ *Dirección:* ${locationAddress}

    ━━━━━━━━━━━━━━━━━━━━━

    📞 _Si tienes dudas, contactanos_`;

    // Si es cuenta business y hay URLs, crear botones
    if (this.isBusinessAccount && (confirmUrl || cancelUrl)) {
      const templateButtons = [];
      
      if (confirmUrl) {
        templateButtons.push({
          index: 1,
          urlButton: {
            displayText: '✅ Confirmar Turno',
            url: confirmUrl
          }
        });
      }
      
      if (cancelUrl) {
        templateButtons.push({
          index: templateButtons.length + 1,
          urlButton: {
            displayText: '❌ Cancelar Turno',
            url: cancelUrl
          }
        });
      }
      
      return {
        text: baseMessage,
        templateButtons: templateButtons
      };
    }
    
    // Para cuentas no business o sin URLs, devolver solo texto
    let textMessage = baseMessage;
    if (confirmUrl || cancelUrl) {
      textMessage += '\n\n📱 *Opciones:*';
      if (confirmUrl) textMessage += `\n✅ Confirmar Turno: ${confirmUrl}`;
      if (cancelUrl) textMessage += `\n❌ Cancelar Turno: ${cancelUrl}`;
    }
    
    return textMessage;
  }

  generateUrgentMessage(data, formattedDate, confirmUrl, cancelUrl) {
    const { professionalName, patientName, serviceName, locationName, time } = data;
    
    const baseMessage = `🚨 *MENSAJE URGENTE*
    ━━━━━━━━━━━━━━━━━━━━━

    ⚠️ *ATENCIÓN ${patientName}*

    Tu turno de *HOY*:

    🏥 *Servicio:* ${serviceName}
    👨‍⚕️ *Profesional:* ${professionalName}
    📅 *Fecha:* ${formattedDate}
    🕐 *Hora:* ${time} hs
    📍 *Lugar:* ${locationName}

    ━━━━━━━━━━━━━━━━━━━━━`;

    // Si es cuenta business y hay URLs, crear botones
    if (this.isBusinessAccount && (confirmUrl || cancelUrl)) {
      const templateButtons = [];
      
      if (confirmUrl) {
        templateButtons.push({
          index: 1,
          urlButton: {
            displayText: '✅ Confirmar Turno',
            url: confirmUrl
          }
        });
      }
      
      if (cancelUrl) {
        templateButtons.push({
          index: templateButtons.length + 1,
          urlButton: {
            displayText: '❌ Cancelar Turno',
            url: cancelUrl
          }
        });
      }
      
      return {
        text: baseMessage,
        templateButtons: templateButtons
      };
    }
    
    // Para cuentas no business o sin URLs, devolver solo texto
    let textMessage = baseMessage;
    if (confirmUrl || cancelUrl) {
      textMessage += '\n\n📱 *RESPONDA INMEDIATAMENTE:*';
      if (confirmUrl) textMessage += `\n✅ Confirmar Turno: ${confirmUrl}`;
      if (cancelUrl) textMessage += `\n❌ Cancelar Turno: ${cancelUrl}`;
    }
    
    return textMessage;
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

// Cambiar de module.exports a export default
export default WhatsAppService;
