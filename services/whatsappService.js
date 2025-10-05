import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import logger from '../utils/logger.js';

function createBaileysLogger() {
  // Logger completamente silencioso
  const silentLogger = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => silentLogger
  };

  return silentLogger;
}

// Función para silenciar logs específicos de libsignal
function suppressLibsignalLogs() {
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;

  // Lista de mensajes a silenciar
  const suppressPatterns = [
    'Failed to decrypt message with any known session',
    'Session error:Error: Bad MAC',
    'Bad MAC',
    'Closing open session in favor of incoming prekey bundle',
    'Closing session: SessionEntry'
  ];

  // Interceptar console.error
  console.error = (...args) => {
    const message = args.join(' ');
    if (!suppressPatterns.some(pattern => message.includes(pattern))) {
      originalConsoleError.apply(console, args);
    }
  };

  // Interceptar console.log
  console.log = (...args) => {
    const message = args.join(' ');
    if (!suppressPatterns.some(pattern => message.includes(pattern))) {
      originalConsoleLog.apply(console, args);
    }
  };

  // Interceptar console.warn
  console.warn = (...args) => {
    const message = args.join(' ');
    if (!suppressPatterns.some(pattern => message.includes(pattern))) {
      originalConsoleWarn.apply(console, args);
    }
  };

  // Retornar función para restaurar logs originales si es necesario
  return () => {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
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
    this.maxReconnectAttempts = 2;
    this.manager = manager;
    this.isBusinessAccount = false;
    // Nuevas propiedades para reconexión automática
    this.reconnectTimeout = null;
    this.isReconnecting = false;
    this.lastReconnectTime = 0;
    this.minReconnectDelay = 2000;
    this.maxReconnectDelay = 10000;
    
    // Propiedades para controlar generación de QR
    this.shouldGenerateQR = false;
    this.latestQR = null;
    
    // Silenciar logs de libsignal
    this.restoreConsole = suppressLibsignalLogs();
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
        browser: ['Chrome', 'Chrome', '120.0.0.0'],
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false
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
      
      // Solo almacenar el QR, no generarlo automáticamente
      if (qr) {
        this.latestQR = qr;
        // Solo generar QR si se solicitó explícitamente
        if (this.shouldGenerateQR) {
          this.generateQRCode(qr);
          this.shouldGenerateQR = false; // Resetear flag después de generar
        }
      }
      
      if (connection === 'close') {
        const disconnectReason = (lastDisconnect?.error)?.output?.statusCode;
        const errorCode = lastDisconnect?.error?.output?.payload?.error;
        
        logger.info(`❌ Conexión cerrada para ${this.phoneNumber} - Razón: ${disconnectReason}, Error: ${errorCode}`);
        
        if (disconnectReason === DisconnectReason.loggedOut) {
          // Sesión cerrada desde el celular - eliminar completamente
          logger.info(`🗑️ Sesión cerrada desde el celular para ${this.phoneNumber} - Eliminando datos`);
          this.connectionState = 'logged_out';
          this.isConnected = false;
          this.reconnectAttempts = 0;
          this.qrCode = null;
          this.latestQR = null;
          this.isBusinessAccount = false;
          this.isReconnecting = false;
          
          // Limpiar timeout de reconexión si existe
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }
          
          // Notificar al manager para que elimine esta instancia completamente
          if (this.manager) {
            this.manager.removeInstanceCompletely(this.phoneNumber);
          }
        } else if (disconnectReason === 515 || errorCode === '515') {
          // Error 515 específico - reconexión automática
          logger.warn(`⚠️ Error 515 detectado para ${this.phoneNumber} - Iniciando reconexión automática`);
          this.connectionState = 'reconnecting';
          this.isConnected = false;
          this.qrCode = null;
          this.latestQR = null;
          this.scheduleReconnect();
        } else if (this.shouldAttemptReconnect(disconnectReason)) {
          // Otros errores recuperables
          logger.info(`🔄 Desconexión recuperable para ${this.phoneNumber} - Programando reconexión`);
          this.connectionState = 'reconnecting';
          this.isConnected = false;
          this.qrCode = null;
          this.latestQR = null;
          this.scheduleReconnect();
        } else {
          // Desconexión no recuperable
          logger.info(`❌ Desconexión no recuperable para ${this.phoneNumber}`);
          this.connectionState = 'disconnected';
          this.isConnected = false;
          this.qrCode = null;
          this.latestQR = null;
          this.isBusinessAccount = false;
          this.isReconnecting = false;
          
          // Limpiar timeout de reconexión si existe
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }
        }
      } else if (connection === 'open') {
        logger.info(`✅ WhatsApp conectado exitosamente para ${this.phoneNumber}`);
        this.isConnected = true;
        this.connectionState = 'connected';
        this.qrCode = null;
        this.latestQR = null;
        this.reconnectAttempts = 0;
        this.isReconnecting = false; // IMPORTANTE: Resetear flag de reconexión
        this.lastReconnectTime = 0;
        
        // Limpiar timeout de reconexión si existe
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        
        // Detectar si es cuenta business
        this.detectBusinessAccount();
      } else if (connection === 'connecting') {
        logger.info(`🔄 Conectando ${this.phoneNumber}...`);
        this.connectionState = 'connecting';
        this.isConnected = false;
      }
    });

    // Manejo de errores de stream (como el error 515)
    this.client.ev.on('stream:error', (error) => {
      logger.error(`🚨 Stream error para ${this.phoneNumber}:`, error);
      
      // Si es error 515, programar reconexión
      if (error.code === '515' || error.message?.includes('515')) {
        logger.warn(`⚠️ Error de stream 515 detectado para ${this.phoneNumber}`);
        this.connectionState = 'reconnecting';
        this.scheduleReconnect();
      }
    });

    this.client.ev.on('creds.update', saveCreds);
  }

  // Determinar si se debe intentar reconectar basado en el código de desconexión
  shouldAttemptReconnect(disconnectReason) {
    const recoverableReasons = [
      DisconnectReason.connectionClosed,
      DisconnectReason.connectionLost,
      DisconnectReason.restartRequired,
      DisconnectReason.timedOut,
      408, // Request timeout
      500, // Internal server error
      502, // Bad gateway
      503  // Service unavailable
    ];
    
    return recoverableReasons.includes(disconnectReason);
  }

  // Programar reconexión con backoff exponencial
  scheduleReconnect() {
    // Evitar múltiples reconexiones simultáneas
    if (this.isReconnecting) {
      logger.info(`⏳ Ya hay una reconexión en progreso para ${this.phoneNumber}`);
      return;
    }

    // Verificar límite de intentos ANTES de incrementar
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`❌ Máximo de intentos de reconexión alcanzado para ${this.phoneNumber} (${this.maxReconnectAttempts})`);
      this.connectionState = 'failed';
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Calcular delay: 2s para el primer intento, 5s para el segundo
    const delay = this.reconnectAttempts === 1 ? 2000 : 5000;

    logger.info(`🔄 Programando reconexión ${this.reconnectAttempts}/${this.maxReconnectAttempts} para ${this.phoneNumber} en ${delay/1000}s`);

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.attemptReconnect();
        // Si llegamos aquí, la reconexión fue exitosa
        logger.info(`✅ Reconexión completada exitosamente para ${this.phoneNumber}`);
        this.isReconnecting = false;
      } catch (error) {
        logger.error(`❌ Error durante reconexión para ${this.phoneNumber}:`, error);
        this.isReconnecting = false;
        
        // Programar siguiente intento si no se alcanzó el límite
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          logger.info(`🔄 Programando siguiente intento de reconexión para ${this.phoneNumber}`);
          // Pequeño delay antes del siguiente intento
          setTimeout(() => {
            this.scheduleReconnect();
          }, 1000);
        } else {
          logger.error(`❌ Todos los intentos de reconexión fallaron para ${this.phoneNumber}`);
          this.connectionState = 'failed';
        }
      }
    }, delay);
  }

  // Intentar reconexión
  async attemptReconnect() {
    logger.info(`🔄 Intentando reconexión ${this.reconnectAttempts}/${this.maxReconnectAttempts} para ${this.phoneNumber}`);
    
    try {
      // Cerrar cliente existente si existe
      if (this.client) {
        try {
          await this.client.end();
        } catch (error) {
          logger.warn(`⚠️ Error cerrando cliente anterior para ${this.phoneNumber}:`, error.message);
        }
      }

      // Limpiar timeout anterior si existe
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      // Reinicializar
      await this.initialize();
      
      this.lastReconnectTime = Date.now();
      logger.info(`✅ Reconexión iniciada exitosamente para ${this.phoneNumber}`);
      
      // NO resetear isReconnecting aquí - se hace en el setTimeout de scheduleReconnect
      
    } catch (error) {
      logger.error(`❌ Error en reconexión para ${this.phoneNumber}:`, error);
      // NO resetear isReconnecting aquí tampoco - se hace en el catch del setTimeout
      throw error;
    }
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

  // Método para solicitar QR explícitamente
  requestQRCode() {
    this.shouldGenerateQR = true;
    // Si ya hay un QR disponible, generarlo inmediatamente
    if (this.latestQR) {
      this.generateQRCode(this.latestQR);
      this.shouldGenerateQR = false;
    }
  }

  // Método para obtener QR sin generar uno nuevo
  getQRCode() {
    return this.qrCode;
  }

  getConnectionState() {
    return {
      isConnected: this.isConnected,
      state: this.connectionState,
      qrCode: this.qrCode,
      phoneNumber: this.phoneNumber,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      isReconnecting: this.isReconnecting,
      isBusinessAccount: this.isBusinessAccount,
      lastUpdate: new Date().toISOString(),
      needsQR: this.connectionState === 'qr_ready' && this.qrCode !== null,
      canConnect: !this.isConnected && this.connectionState !== 'connecting'
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
    // Parsear la fecha como está, sin conversión de zona horaria
    // Asumiendo formato YYYY-MM-DD o similar
    let date;
    
    if (dateStr.includes('-')) {
      // Formato YYYY-MM-DD
      const [year, month, day] = dateStr.split('-').map(Number);
      date = new Date(year, month - 1, day); // month - 1 porque Date usa 0-11 para meses
    } else {
      // Si viene en otro formato, usar Date pero forzar UTC para evitar conversiones
      date = new Date(dateStr + 'T00:00:00');
    }
    
    // Para comparar con hoy y mañana, usar la misma lógica sin zona horaria
    const today = new Date();
    const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    
    const tomorrow = new Date(todayLocal);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 
                       'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    
    const dayName = dayNames[date.getDay()];
    const day = date.getDate();
    const month = monthNames[date.getMonth()];
    
    // Comparar solo año, mes y día (sin hora)
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    if (dateOnly.getTime() === todayLocal.getTime()) {
      return `HOY - ${dayName} ${day} de ${month}`;
    } else if (dateOnly.getTime() === tomorrow.getTime()) {
      return `MAÑANA - ${dayName} ${day} de ${month}`;
    } else {
      return `${dayName} ${day} de ${month}`;
    }
  }

  generateConfirmationMessage(data, formattedDate, confirmUrl, cancelUrl) {
    const { professionalName, patientName, serviceName, locationName, time, locationAddress } = data;
    
    const baseMessage = `📅 *TURNO ASIGNADO*

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
    
    const baseMessage = `
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
    logger.info(`🛑 Cerrando conexión WhatsApp para ${this.phoneNumber}...`);
    
    // Limpiar timeout de reconexión
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    this.isReconnecting = false;
    
    if (this.client) {
      try {
        await this.client.end();
        logger.info(`✅ Conexión cerrada exitosamente para ${this.phoneNumber}`);
      } catch (error) {
        logger.error(`❌ Error cerrando conexión para ${this.phoneNumber}:`, error);
      }
    }
    
    // Restaurar console original si es necesario
    if (this.restoreConsole) {
      this.restoreConsole();
    }
    
    this.isConnected = false;
    this.connectionState = 'disconnected';
  }
}

// Cambiar de module.exports a export default
export default WhatsAppService;
