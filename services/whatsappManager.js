const WhatsAppService = require('./whatsappService');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

class WhatsAppManager {
  constructor() {
    this.instances = new Map(); // phoneNumber -> WhatsAppService
    this.authBaseDir = './auth_info_baileys';
    
    // Crear directorio base si no existe
    if (!fs.existsSync(this.authBaseDir)) {
      fs.mkdirSync(this.authBaseDir, { recursive: true });
    }
  }

  // Obtener o crear instancia para un número
  async getInstance(phoneNumber) {
    // Limpiar y normalizar número
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    if (this.instances.has(cleanNumber)) {
      return this.instances.get(cleanNumber);
    }

    // Crear nueva instancia
    const authDir = path.join(this.authBaseDir, cleanNumber);
    const instance = new WhatsAppService(cleanNumber, authDir);
    
    this.instances.set(cleanNumber, instance);
    
    // Inicializar la instancia
    try {
      await instance.initialize();
      logger.info(`✅ Instancia creada para ${cleanNumber}`);
    } catch (error) {
      logger.error(`❌ Error creando instancia para ${cleanNumber}:`, error);
      this.instances.delete(cleanNumber);
      throw error;
    }
    
    return instance;
  }

  // Obtener todas las instancias activas
  getAllInstances() {
    const instances = {};
    for (const [phoneNumber, service] of this.instances) {
      instances[phoneNumber] = service.getConnectionState();
    }
    return instances;
  }

  // Cerrar instancia específica
  async closeInstance(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const instance = this.instances.get(cleanNumber);
    
    if (instance) {
      await instance.gracefulShutdown();
      this.instances.delete(cleanNumber);
      logger.info(`🔄 Instancia cerrada para ${cleanNumber}`);
    }
  }

  // Cerrar todas las instancias
  async closeAllInstances() {
    const promises = [];
    for (const [phoneNumber, instance] of this.instances) {
      promises.push(instance.gracefulShutdown());
    }
    
    await Promise.all(promises);
    this.instances.clear();
    logger.info('🔄 Todas las instancias cerradas');
  }

  // Cargar instancias existentes al iniciar
  async loadExistingInstances() {
    try {
      if (!fs.existsSync(this.authBaseDir)) {
        return;
      }

      const authDirs = fs.readdirSync(this.authBaseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const phoneNumber of authDirs) {
        // Solo cargar si tiene credenciales válidas
        const credsPath = path.join(this.authBaseDir, phoneNumber, 'creds.json');
        if (fs.existsSync(credsPath)) {
          try {
            await this.getInstance(phoneNumber);
            logger.info(`🔄 Instancia restaurada para ${phoneNumber}`);
          } catch (error) {
            logger.warn(`⚠️ No se pudo restaurar instancia para ${phoneNumber}:`, error.message);
          }
        }
      }
    } catch (error) {
      logger.error('Error cargando instancias existentes:', error);
    }
  }
}

module.exports = WhatsAppManager;