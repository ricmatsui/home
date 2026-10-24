const post = (url, values = {}) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
    });

const fetchJson = async (url) => (await fetch(url)).json();

const modelRoot = '/model/'
    + document.querySelector("meta[name='model-revision']").content;

const [roster, labels] = await Promise.all([
    fetchJson('gestures.json'),
    fetchJson(`${modelRoot}/gestures.json`),
]);
const actions = new Map(roster.map((gesture) => [gesture.name, gesture]));

const modelStatus = document.querySelector('.model-status');
const modelState = document.querySelector('.model-state');
const modelDetail = document.querySelector('.model-detail');

// A failed load or a lost WebGL context leaves no usable model, so the next
// gesture starts over from a fresh backend instead of staying stuck.
let model = null;
let loadingModel = null;
let isFirstModelLoad = true;

// How long a gesture waits on a loading model before it's dropped; any
// longer and the action lands well after the swipe that asked for it.
const modelWaitMilliseconds = 2000;

// A broken backend gets a fresh model and another try at the same gesture,
// up to this many predictions in all.
const classifyAttempts = 3;

const modelStateNames = { loading: 'Loading', ready: 'Ready', failed: 'Failed' };

const showModelStatus = (state, detail = state) => {
    modelStatus.dataset.state = state;
    modelState.innerText = modelStateNames[state];
    modelDetail.innerText = `model: ${detail}`;
};

modelStatus.addEventListener('click', () => {
    modelDetail.hidden = !modelDetail.hidden;
});

const loadModel = async () => {
    showModelStatus('loading');

    if (!isFirstModelLoad) {
        tf.engine().reset();
    }
    isFirstModelLoad = false;
    await tf.ready();

    const model = await tf.loadLayersModel(`${modelRoot}/model.json`);

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

    // The first predict compiles the backend's kernels; pay for it now
    // rather than on the first gesture.
    const input = tf.zeros([1, ...model.inputs[0].shape.slice(1)]);
    const output = model.predict(input);
    await output.data();
    tf.dispose([input, output]);

    return model;
};

const startLoadingModel = () =>
    loadingModel ??= loadModel()
        .then((loadedModel) => {
            model = loadedModel;
            showModelStatus('ready', `ready (${tf.getBackend()})`);
        })
        .catch((error) => {
            console.error(error);
            showModelStatus('failed', `failed: ${error.message}`);
        })
        .finally(() => {
            loadingModel = null;
        });

startLoadingModel();

const waitForModel = () => Promise.race([
    startLoadingModel(),
    new Promise((resolve) => setTimeout(resolve, modelWaitMilliseconds)),
]);

const classify = (image) => {
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
            total: probabilityTensor.sum().dataSync()[0],
        };
    });

    // Softmax output sums to 1; anything else is a broken backend (a lost
    // WebGL context reads back zeros), not an unrecognized gesture.
    if (!(Math.abs(result.total - 1) < 0.01)) {
        throw new Error(`probabilities sum to ${result.total}`);
    }

    return result;
};

class Point {
    constructor(x, y) {
        this.X = x;
        this.Y = y;
    }
}

// The browser drops the lock whenever the page is hidden, so take it again
// on return, and on any touch in case a request was refused.
let isWakeLockRequested = false;

const ensureWakeLock = async () => {
    if (!('wakeLock' in navigator) || isWakeLockRequested || document.hidden) {
        return;
    }

    isWakeLockRequested = true;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
            isWakeLockRequested = false;
        });
    } catch (error) {
        isWakeLockRequested = false;
        console.warn(`wake lock: ${error.message}`);
    }
};

ensureWakeLock();
document.addEventListener('visibilitychange', ensureWakeLock);
document.addEventListener('pointerdown', ensureWakeLock);

const svgNamespace = 'http://www.w3.org/2000/svg';

// A roster stroke is only the line, in drawing order; the start dot and the
// arrowhead come from shared markers so every gesture shows direction alike.
const strokeIcon = (stroke, { isUntrained = false } = {}) => {
    const tone = isUntrained ? 'untrained' : 'ink';
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', stroke);
    path.setAttribute('class', isUntrained ? 'stroke untrained' : 'stroke');
    path.setAttribute('marker-start', `url(#stroke-start-${tone})`);
    path.setAttribute('marker-end', `url(#stroke-head-${tone})`);
    svg.appendChild(path);
    return svg;
};

const isTrained = (gesture) => labels.some((label) => label.name === gesture.name);

const helpButton = document.querySelector('.help-button');
const helpSheet = document.querySelector('.help-sheet');

for (const gesture of roster) {
    const isUntrained = !isTrained(gesture);
    const tile = document.createElement('div');
    tile.className = 'help-gesture';
    const caption = document.createElement('span');
    caption.innerText = gesture.label;
    caption.classList.toggle('untrained', isUntrained);
    tile.append(strokeIcon(gesture.stroke, { isUntrained }), caption);
    document.querySelector('.help-gestures').appendChild(tile);
}
document.querySelector('.help-legend').hidden = roster.every(isTrained);

const setHelpOpen = (isOpen) => {
    helpSheet.hidden = !isOpen;
    helpButton.setAttribute('aria-pressed', String(isOpen));
};

helpButton.addEventListener('click', () => setHelpOpen(helpSheet.hidden));
document.querySelector('.help-close').addEventListener('click', () => setHelpOpen(false));

// Newest first; a fresh Dev session starts empty, the saved samples stay saved.
const recentSampleLimit = 5;
let recentSamples = [];
const recentSamplesStrip = document.querySelector('.recent-samples');

const showRecentSamples = () => {
    recentSamplesStrip.replaceChildren(...recentSamples.map(({ gesture, imageUrl }) => {
        const sample = document.createElement('div');
        sample.className = 'recent-sample';
        const image = document.createElement('img');
        image.src = imageUrl;
        const caption = document.createElement('span');
        caption.innerText = gesture;
        sample.append(image, caption);
        return sample;
    }));
};

document.querySelector('.delete-button').addEventListener('click', () => {
    post('/delete').then(() => {
        recentSamples = recentSamples.slice(1);
        showRecentSamples();

        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }
    });
});

// A gesture the deployed model has no class for yet needs samples before it
// can be trained, so recording asks only for those while any exist.
const untrainedIndices = roster
    .map((gesture, index) => index)
    .filter((index) => !isTrained(roster[index]));
const recordableIndices = untrainedIndices.length
    ? untrainedIndices
    : roster.map((gesture, index) => index);

const randomRecordableIndex = () =>
    recordableIndices[Math.floor(Math.random() * recordableIndices.length)];

let lastGestureIndex = null;
let recordingGestureIndex = randomRecordableIndex();
let nextRecordingGestureIndex = randomRecordableIndex();

let isRecording = false;
let isTesting = false;

const devButton = document.querySelector('.dev-button');
const devToolbar = document.querySelector('.dev-toolbar');
const devDebug = document.querySelector('.dev-debug');
const recordButton = document.querySelector('.record-button');
const testButton = document.querySelector('.test-button');
const recordPrompt = document.querySelector('.record-prompt');
const lastGesture = document.querySelector('.last-gesture');

const showPromptGesture = (element, gesture) => {
    element.replaceChildren(strokeIcon(gesture.stroke), gesture.name);
};

const updateRecordState = () => {
    recordButton.setAttribute('aria-pressed', String(isRecording));
    recordPrompt.hidden = !isRecording;
    recentSamplesStrip.hidden = !isRecording;
    lastGesture.hidden = isRecording;

    if (!isRecording) {
        return;
    }

    recordingGestureIndex = nextRecordingGestureIndex;

    do {
        nextRecordingGestureIndex = randomRecordableIndex();
    } while (
        recordableIndices.length > 1
        && nextRecordingGestureIndex === recordingGestureIndex
    )

    // A recognized gesture is always a trained one, so it can't stand in
    // while untrained ones are waiting for samples.
    if (lastGestureIndex !== null && !untrainedIndices.length) {
        recordingGestureIndex = lastGestureIndex;
        nextRecordingGestureIndex = lastGestureIndex;
    }

    showPromptGesture(document.querySelector('.record-prompt-now'), roster[recordingGestureIndex]);
    showPromptGesture(document.querySelector('.record-prompt-next'), roster[nextRecordingGestureIndex]);
}

recordButton.addEventListener('click', () => {
    isRecording = !isRecording;
    updateRecordState();
});

testButton.addEventListener('click', () => {
    isTesting = !isTesting;
    testButton.setAttribute('aria-pressed', String(isTesting));
});

// Leaving Dev always returns to a remote that sends to the TV.
devButton.addEventListener('click', () => {
    const isDev = devToolbar.hidden;
    devButton.setAttribute('aria-pressed', String(isDev));
    devToolbar.hidden = !isDev;
    devDebug.hidden = !isDev;

    if (!isDev) {
        isRecording = false;
        isTesting = false;
        testButton.setAttribute('aria-pressed', 'false');
        recentSamples = [];
        showRecentSamples();
        updateRecordState();
    }
});

// Repeats of the same thing count up; anything else starts over. The count
// outlives the fade, so a repeat after a pause still reads "x2".
let lastGestureLabel = null;
let lastGestureCount = 0;
let lastGestureFade = null;

const lastGestureIdleMilliseconds = 500;

const showLastGesture = (label) => {
    clearTimeout(lastGestureFade);
    lastGesture.classList.remove('fading');
    lastGestureFade = setTimeout(
        () => lastGesture.classList.add('fading'),
        lastGestureIdleMilliseconds
    );

    lastGestureCount = label === lastGestureLabel ? lastGestureCount + 1 : 1;
    lastGestureLabel = label;

    const nodes = [label];
    if (lastGestureCount > 1) {
        const count = document.createElement('small');
        count.innerText = ` x${lastGestureCount}`;
        nodes.push(count);
    }
    lastGesture.replaceChildren(...nodes);
};

const flashZone = (zone) => {
    zone.classList.add('flash');
    setTimeout(() => zone.classList.remove('flash'), 150);
};

const history = [];

let points = null;
let isDown = false;

const page = document.querySelector('.page');
const trail = document.querySelector('.trail');
const trailG = trail.getContext('2d');

// The same dark-to-light ramp the model sees, lifted so the start shows on black.
const drawTrail = () => {
    trailG.clearRect(0, 0, trail.width, trail.height);
    trailG.lineWidth = 4 * devicePixelRatio;
    trailG.lineCap = 'round';
    trailG.lineJoin = 'round';

    for (let i = 1; i < points.length; i++) {
        const t = i / (points.length - 1);
        trailG.strokeStyle = `hsl(0, 0%, ${Math.round(25 + t * 70)}%)`;
        trailG.beginPath();
        trailG.moveTo(points[i - 1].X * devicePixelRatio, points[i - 1].Y * devicePixelRatio);
        trailG.lineTo(points[i].X * devicePixelRatio, points[i].Y * devicePixelRatio);
        trailG.stroke();
    }
};

page.addEventListener('pointerdown', (event) => {
    if (navigator.vibrate) {
        navigator.vibrate([1]);
    }
    isDown = true;
    points = [new Point(event.clientX, event.clientY)];

    trail.width = page.clientWidth * devicePixelRatio;
    trail.height = page.clientHeight * devicePixelRatio;
    trail.classList.remove('fading');
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
        drawTrail();
    }
})

const showGestureDebug = (details) => {
    document.querySelector('.gesture-debug').innerText = JSON.stringify(
        { pointCount: points.length, ...details },
        null,
        1
    );
};

const rejectGesture = (details) => {
    showGestureDebug(details);
    showLastGesture('?');

    if (navigator.vibrate) {
        navigator.vibrate([2, 2, 2]);
    }
};

page.addEventListener('pointerup', async (event) => {
    isDown = false;
    trail.classList.add('fading');

    if (points.length < 3) {
        if (points[0].X < document.body.clientWidth * 0.2) {
            if (navigator.vibrate) {
                navigator.vibrate([2]);
            }
            flashZone(document.querySelector('.zone-left'));
            showLastGesture('volumeDown');
            handleInput({ name: 'volumeDown' });
            return;
        }

        if (points[0].X > document.body.clientWidth * 0.8) {
            if (navigator.vibrate) {
                navigator.vibrate([2]);
            }
            flashZone(document.querySelector('.zone-right'));
            showLastGesture('volumeUp');
            handleInput({ name: 'volumeUp' });
            return;
        }

        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }
        showLastGesture('click');
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

    if (isRecording) {
        const gesture = roster[recordingGestureIndex].name;

        post('/record', { gesture, image: imageUrl });

        recentSamples = [{ gesture, imageUrl }, ...recentSamples].slice(0, recentSampleLimit);
        showRecentSamples();

        if (navigator.vibrate) {
            navigator.vibrate([2]);
        }

        updateRecordState();
        return;
    }

    let result;
    let brokenError = null;

    for (let attempt = 0; attempt < classifyAttempts && !result; attempt++) {
        if (!model) {
            await waitForModel();
        }

        if (!model) {
            break;
        }

        try {
            result = classify(image);
        } catch (error) {
            console.error(error);
            brokenError = error;
            model = null;
            startLoadingModel();
        }
    }

    if (!result) {
        rejectGesture({
            gesture: null,
            model: brokenError ? `broken: ${brokenError.message}` : 'not ready',
        });
        return;
    }

    console.log(result);

    const gesture = actions.get(labels[result.index].name);

    if (result.value < 0.6) {
        rejectGesture({ gesture: 'unknown', result: result.value });
        return;
    }

    lastGestureIndex = result.index;

    showGestureDebug({ gesture: gesture.name, result: result.value });
    showLastGesture(gesture.name);

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

    if (name == 'netflix' || name == 'peacock' || name == 'appleTV' || name == 'youtube') {
        let appId;

        switch (name) {
            case 'netflix':
                appId = '3201907018807';
                break;
            case 'peacock':
                appId = '3202006020991';
                break;
            case 'appleTV':
                appId = '3201807016597';
                break;
            case 'youtube':
                appId = '111299001912';
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
