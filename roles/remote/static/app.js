const post = (url, values = {}) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
    });

const roster = await (await fetch('gestures.json')).json();
const actions = new Map(roster.map((gesture) => [gesture.name, gesture]));

const labels = await (await fetch('/model/gestures.json')).json();
const modelPromise = tf.loadLayersModel('/model/model.json').then((model) => {
    if (labels.length !== model.outputs[0].shape[1]) {
        throw new Error(
            `model has ${model.outputs[0].shape[1]} outputs but `
            + `${labels.length} labels were published alongside it`
        );
    }

    const orphans = labels.filter((label) => !actions.has(label.name));
    if (orphans.length) {
        throw new Error(
            'model predicts classes with no action: '
            + orphans.map((label) => label.name).join(', ')
        );
    }

    return model;
});

class Point {
    constructor(x, y) {
        this.X = x;
        this.Y = y;
    }
}

if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch((error) => alert(error.message));
}

document.querySelector('.help-button').addEventListener('click', () => {
    const image = document.createElement('img');
    image.src = 'help.jpg';
    image.style.position = 'absolute';
    image.style.top = '0';
    image.style.left = '0';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style['object-fit'] = 'contain';
    document.body.appendChild(image);
    image.addEventListener('click', () => {
        document.body.removeChild(image);
    });
})

document.querySelector('.delete-button').addEventListener('click', () => {
    post('/delete').then(() => {
        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }
    });
});

let lastGestureIndex = null;
let recordingGestureIndex = Math.floor(Math.random() * roster.length);
let nextRecordingGestureIndex = Math.floor(Math.random() * roster.length);

const record = document.querySelector('.record');
const recordInstructions = document.querySelector('.record-instructions');

const updateRecordState = () => {
    if (record.checked) {
        recordingGestureIndex = nextRecordingGestureIndex;

        do {
            nextRecordingGestureIndex = Math.floor(Math.random() * roster.length);
        } while (nextRecordingGestureIndex === recordingGestureIndex)

        if (lastGestureIndex !== null) {
            recordingGestureIndex = lastGestureIndex;
            nextRecordingGestureIndex = lastGestureIndex;
        }

        recordInstructions.innerText = roster[recordingGestureIndex].name.padStart(15) + ', ' + roster[nextRecordingGestureIndex].name.padStart(15);
    } else {
        recordInstructions.innerText = '';
    }
}

record.addEventListener('change', () => {
    updateRecordState();
});

let test = document.querySelector('.test');
let isTesting = false;

test.addEventListener('change', () => {
    isTesting = test.checked
});


const history = [];

let points = null;
let isDown = false;

const page = document.querySelector('.page');

page.addEventListener('pointerdown', (event) => {
    if (navigator.vibrate) {
        navigator.vibrate([1]);
    }
    isDown = true;
    points = [new Point(event.clientX, event.clientY)];
});

page.addEventListener('pointermove', (event) => {
    if (!isDown) {
        return;
    }
    const point = new Point(event.clientX, event.clientY);
    const lastPoint = points[points.length - 1];
    const distanceSquared = Math.pow(lastPoint.X - point.X, 2) + Math.pow(lastPoint.Y - point.Y, 2);

    if (distanceSquared > Math.pow(document.body.clientWidth / 100, 2)) {
        points.push(point);
    }
})

page.addEventListener('pointerup', async (event) => {
    isDown = false;

    if (points.length < 3) {
        if (points[0].X < document.body.clientWidth * 0.2) {
            if (navigator.vibrate) {
                navigator.vibrate([2]);
            }
            handleInput({ name: 'volumeDown' });
            return;
        }

        if (points[0].X > document.body.clientWidth * 0.8) {
            if (navigator.vibrate) {
                navigator.vibrate([2]);
            }
            handleInput({ name: 'volumeUp' });
            return;
        }

        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }
        handleInput({ name: 'click' });
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;

    const g = canvas.getContext('2d');
    g.fillStyle = 'black';
    g.fillRect(0, 0, canvas.width, canvas.height);

    const topLeft = new Point(points[0].X, points[0].Y);
    const bottomRight = new Point(points[0].X, points[0].Y);

    for (let i = 0; i < points.length; i++) {
        topLeft.X = Math.min(points[i].X, topLeft.X);
        topLeft.Y = Math.min(points[i].Y, topLeft.Y);
        bottomRight.X = Math.max(points[i].X, bottomRight.X);
        bottomRight.Y = Math.max(points[i].Y, bottomRight.Y);
    }

    const padding = 2;

    const width = bottomRight.X - topLeft.X;
    const height = bottomRight.Y - topLeft.Y;

    let scale = (canvas.width - padding * 2) / Math.max(width, height, 1);

    for (let i = 0; i < points.length; i++) {
        points[i].X = (points[i].X - topLeft.X) * scale;
        points[i].Y = (points[i].Y - topLeft.Y) * scale;
    }

    const offsetX = (canvas.width - (width * scale)) / 2;
    const offsetY = (canvas.height - (height * scale)) / 2;

    for (let i = 0; i < points.length; i++) {
        points[i].X += offsetX;
        points[i].Y += offsetY;
    }

    g.lineWidth = 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (let i = 1; i < points.length; i++) {
        const t = i / (points.length - 1);
        g.strokeStyle = `hsl(0, 0%, ${Math.round(10 + t * 80)}%)`;
        g.beginPath();
        g.moveTo(points[i - 1].X, points[i - 1].Y);
        g.lineTo(points[i].X, points[i].Y);
        g.stroke();
    }

    const imageUrl = canvas.toDataURL('image/png');

    const image = await createImageBitmap(await (await fetch(imageUrl)).blob());

    const debugCanvas = document.querySelector('.debug-canvas');

    const debugG = debugCanvas.getContext('2d');
    debugG.imageSmoothingEnabled = false;
    debugG.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
    debugG.drawImage(image, 0, 0, debugCanvas.width, debugCanvas.height);

    if (record.checked) {
        post('/record', {
            gesture: roster[recordingGestureIndex].name,
            image: imageUrl,
        });

        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }

        updateRecordState();
        return;
    }

    const model = await modelPromise;

    const result = tf.tidy(() => {
        const probabilityTensor = model.predict(
            tf.browser
                .fromPixels(image, 1)
                .toFloat()
                .div(255.0)
                .expandDims(0)
        )

        probabilityTensor.print();

        const result = tf.topk(probabilityTensor, 1);

        return {
            index: result.indices.dataSync()[0],
            value: result.values.dataSync()[0],
        };
    });

    console.log(result);

    const gesture = actions.get(labels[result.index].name);

    if (result.value < 0.6) {
        document.querySelector('.gesture-debug').innerText = JSON.stringify(
            {
                pointCount: points.length,
                gesture: 'unknown',
                result: result.value,
            },
            null,
            4
        );

        if (navigator.vibrate) {
            navigator.vibrate([2, 2, 2]);
        }
        return;
    }

    lastGestureIndex = result.index;

    document.querySelector('.gesture-debug').innerText = JSON.stringify(
        {
            pointCount: points.length,
            gesture: gesture.name,
            result: result.value,
        },
        null,
        4
    );

    handleInput({ name: gesture.action });

    if (navigator.vibrate) {
        navigator.vibrate([2]);
    }
})

const handleInput = ({ name }) => {
    if (isTesting) {
        return;
    }

    // All apps
    //method: 'ms.channel.emit',
    //params: {
    //  data: '',
    //  event: 'ed.installedApp.get',
    //  to: 'host',
    //},

    if (name == 'netflix' || name == 'peacock') {
        let appId;

        switch (name) {
            case 'netflix':
                appId = '3201907018807';
                break;
            case 'peacock':
                appId = '3202006020991';
                break;
        }

        const message = {
            kind: name,
            data: {
                method: 'ms.channel.emit',
                params: {
                    data: {
                        action_type: 'DEEP_LINK',
                        appId,
                    },
                    event: 'ed.apps.launch',
                    to: 'host',
                },
            },
        }

        post('/control', { message: JSON.stringify(message) });
        return;
    }


    let key;

    switch (name) {
        case 'left':
            key = 'KEY_LEFT';
            break;
        case 'right':
            key = 'KEY_RIGHT';
            break;
        case 'up':
            key = 'KEY_UP';
            break;
        case 'down':
            key = 'KEY_DOWN';
            break;
        case 'volumeUp':
            key = 'KEY_VOLUP';
            break;
        case 'volumeDown':
            key = 'KEY_VOLDOWN';
            break;
        case 'click':
            key = 'KEY_ENTER';
            break;
        case 'back':
            key = 'KEY_RETURN';
            break;
        case 'home':
            key = 'KEY_HOME';
            break;
        case 'powerOn':
            key = 'KEY_POWER';
            break;
        case 'powerOff':
            key = 'KEY_POWER';
            break;
    }

    const message = {
        kind: name,
        data: {
            method: 'ms.remote.control',
            params: {
                Cmd: 'Click',
                DataOfCmd: key,
                Option: 'false',
                TypeOfRemote: 'SendRemoteKey',
            },
        },
    };

    post('/control', { message: JSON.stringify(message) });
};
