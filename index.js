const ruuvi = require('node-ruuvitag');
const io = require('socket.io-client');
var socket;

const debug = require('debug')('homebridge-ruuvitag');

let Service;
let Characteristic;

const waitingTags = {};
const tags = {};

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-ruuvitag', 'Ruuvitag', Ruuvitag);
};

class Ruuvitag {
  constructor (log, config) {
    this.log = log;
    this.name = config.name;
    this.id = config.id;
    this.config = config;
    this.updatedAt = 0;

    if (config.socket) {
      socket = io.connect(config.socket);
      debug('socket set to:', config.socket)
    } else {
      ruuvi.on('found', tag => {
        tags[tag.id] = tag;
        waitingTags[tag.id] && waitingTags[tag.id](tag);
        delete waitingTags[tag.id];
        debug('found', tag.id);
      });
    }

    if (!config.disableTemp) {
      this.tempService = new Service.TemperatureSensor(this.name);
      this.tempService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -200, maxValue: 200, minStep: 0.01 });
    }
    if (!config.disableHumidity) {
      this.humidityService = new Service.HumiditySensor(this.name);
      this.humidityService
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .setProps({ minValue: 0, maxValue: 100, minStep: 0.5 });
    }
    // Service.BatteryService was removed in Homebridge 2 (HAP-NodeJS 1.x+)
    const BatteryService = Service.Battery || Service.BatteryService;
    this.batteryService = new BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGEABLE);

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Ruuvi')
      .setCharacteristic(Characteristic.Model, 'RuuviTag')
      .setCharacteristic(Characteristic.SerialNumber, String(this.id || 'unknown'));

    if (config.heatTrigger) {
      this.heatTriggerService = new Service.ContactSensor(config.heatTrigger.name || this.name, 'heat');
      this.heatTriggerValue = Number(config.heatTrigger.value || 0);
    }

    if (config.coldTrigger) {
      this.coldTriggerService = new Service.ContactSensor(config.coldTrigger.name || this.name, 'cold');
      this.coldTriggerValue = Number(config.coldTrigger.value || 0);
    }

    if (config.motionTrigger) {
      this.motionTriggerService = new Service.MotionSensor(config.motionTrigger.name || this.name);
      this.motionTriggerValue = Number(config.motionTrigger.value || 0);
    }

    if (config.highHumidityTrigger) {
      this.highHumidityTriggerService = new Service.ContactSensor(config.highHumidityTrigger.name || this.name, 'highHumidity');
      this.highHumidityTriggerValue = Number(config.highHumidityTrigger.value || 0);
    }

    if (config.lowHumidityTrigger) {
      this.lowHumidityTriggerService = new Service.ContactSensor(config.lowHumidityTrigger.name || this.name, 'lowHumidity');
      this.lowHumidityTriggerValue = Number(config.lowHumidityTrigger.value || 0);
    }

    var tag;
    var listenTo;
    if (config.socket) {
      tags[this.id] = { id: this.id };
      tag = tags[this.id];
      listenTo = (tag) => {
        socket.on('updated', (data) => {
          if (data.tagId == tag.id) {
            this.update(tag, data);
          }
        });
      }
    } else {
      listenTo = (tag) => {
        tag.on('updated', (data) => {
          this.update(tag, data);
        });
      }
    }

    if (tag) {
      listenTo(tag);
    } else {
      waitingTags[this.id] = (tag) => {
        listenTo(tag);
      };
    }
  }

  update (tag, data) {
    const { config } = this;
    const { temperature, humidity, battery, accelerationX, accelerationY, accelerationZ } = data;
    const previous = tag.previousValues;

    tag.previousValues = data;

    const now = Date.now();

    if ((config.frequency == null) || ((now - this.updatedAt) > config.frequency * 1000)) {
      this.updatedAt = now;

      if (!config.disableTemp && isNumber(temperature)) {
        if (temperature !== this.temperature) {
          this.temperature = temperature;
          this.tempService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(temperature);
        }
      }

      if (!config.disableHumidity && isNumber(humidity)) {
        if (humidity !== this.humidity) {
          this.humidity = humidity;
          this.humidityService
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .updateValue(humidity);
        }
      }
      // BatteryLevel is an integer (uint8) characteristic
      const batteryLevel = Math.round(Math.max(0, Math.min(100, (battery - 2000) / 1000 * 100)));
      if (isNumber(battery) && batteryLevel !== this.batteryLevel) {
        this.batteryLevel = batteryLevel;
        this.batteryService
          .getCharacteristic(Characteristic.BatteryLevel)
          .updateValue(batteryLevel);
      }
    }

    const batteryState = (battery < 2000)
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    if (isNumber(battery) && batteryState !== this.batteryState) {
      this.batteryState = batteryState;
      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .updateValue(batteryState);
    }

    if (config.heatTrigger && isNumber(temperature)) {
      const heatState = (temperature > this.heatTriggerValue) ? 1 : 0;

      if (heatState !== this.heatState) {
        this.heatState = heatState;
        this.heatTriggerService
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(heatState);
      }
    }

    if (config.coldTrigger && isNumber(temperature)) {
      const coldState = (temperature < this.coldTriggerValue) ? 1 : 0;

      if (coldState !== this.coldState) {
        this.coldState = coldState;
        this.coldTriggerService
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(coldState);
      }
    }

    if (config.highHumidityTrigger && isNumber(humidity)) {
      const highHumidityState = (humidity > this.highHumidityTriggerValue) ? 1 : 0;

      if (highHumidityState !== this.highHumidityState) {
        this.highHumidityState = highHumidityState;
        this.highHumidityTriggerService
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(highHumidityState);
      }
    }

    if (config.lowHumidityTrigger && isNumber(humidity)) {
      const lowHumidityState = (humidity < this.lowHumidityTriggerValue) ? 1 : 0;

      if (lowHumidityState !== this.lowHumidityState) {
        this.lowHumidityState = lowHumidityState;
        this.lowHumidityTriggerService
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(lowHumidityState);
      }
    }

    if (config.motionTrigger) {
      const deltaX = previous ? (previous.accelerationX - accelerationX) : 0;
      const deltaY = previous ? (previous.accelerationY - accelerationY) : 0;
      const deltaZ = previous ? (previous.accelerationZ - accelerationZ) : 0;

      const movement = previous ? (hypotenuse(deltaX, deltaY, deltaZ) / 1000) : 0;

      const motionState = movement > this.motionTriggerValue;

      if (motionState !== this.motionState) {
        this.motionState = motionState;
        this.motionTriggerService
          .getCharacteristic(Characteristic.MotionDetected)
          .updateValue(motionState);
      }
    }
    debug(data);
  }

  getServices () {
    const services = [this.informationService];

    if (this.tempService) {
      services.push(this.tempService);
    }

    if (this.humidityService) {
      services.push(this.humidityService);
    }

    services.push(this.batteryService);

    if (this.heatTriggerService) {
      services.push(this.heatTriggerService);
    }

    if (this.coldTriggerService) {
      services.push(this.coldTriggerService);
    }

    if (this.highHumidityTriggerService) {
      services.push(this.highHumidityTriggerService);
    }

    if (this.lowHumidityTriggerService) {
      services.push(this.lowHumidityTriggerService);
    }

    if (this.motionTriggerService) {
      services.push(this.motionTriggerService);
    }

    return services;
  }
}

function isNumber (value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hypotenuse (a, b, c = 0) {
  return Math.sqrt(Math.pow(a, 2) + Math.pow(b, 2) + Math.pow(c, 2));
}
