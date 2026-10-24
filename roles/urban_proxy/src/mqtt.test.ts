import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveryPayloads, stateTopic, AVAILABILITY_TOPIC } from './mqtt.js';

test('publishes one sensor config per Urban reading on homeassistant topics', () => {
    assert.deepEqual(
        discoveryPayloads().map(({ topic }) => topic),
        [
            'homeassistant/sensor/urban/temperature/config',
            'homeassistant/sensor/urban/humidity/config',
            'homeassistant/sensor/urban/pressure/config',
            'homeassistant/sensor/urban/pm1/config',
            'homeassistant/sensor/urban/pm2_5/config',
            'homeassistant/sensor/urban/pm10/config',
            'homeassistant/sensor/urban/ec02/config',
            'homeassistant/sensor/urban/tvoc/config',
            'homeassistant/sensor/urban/noise/config',
        ],
    );
});

test('every sensor shares the Urban device and the proxy availability, and expires after 10 minutes', () => {
    for (const { payload } of discoveryPayloads()) {
        assert.equal(payload.availability_topic, AVAILABILITY_TOPIC);
        assert.deepEqual(payload.device, {
            identifiers: ['urban'],
            name: 'Urban',
            manufacturer: 'Pimoroni',
            model: 'Enviro Urban',
        });
        assert.equal(payload.expire_after, 600);
        assert.equal(payload.state_class, 'measurement');
    }
});

test('a sensor reads its state from its reading topic', () => {
    const [temperature] = discoveryPayloads();

    assert.equal(temperature.payload.unique_id, 'urban_temperature');
    assert.equal(temperature.payload.state_topic, stateTopic('temperature'));
    assert.equal(stateTopic('temperature'), 'urban/temperature/state');
});

test('each sensor carries the device class and unit of the sensor that measures it', () => {
    const byKey = Object.fromEntries(
        discoveryPayloads().map(({ payload }) => [
            String(payload.unique_id).replace(/^urban_/, ''),
            [payload.device_class, payload.unit_of_measurement],
        ]),
    );

    assert.deepEqual(byKey, {
        temperature: ['temperature', '°C'],
        humidity: ['humidity', '%'],
        pressure: ['atmospheric_pressure', 'hPa'],
        pm1: ['pm1', 'µg/m³'],
        pm2_5: ['pm25', 'µg/m³'],
        pm10: ['pm10', 'µg/m³'],
        ec02: ['carbon_dioxide', 'ppm'],
        tvoc: ['volatile_organic_compounds_parts', 'ppb'],
        noise: [undefined, 'V'],
    });
});
