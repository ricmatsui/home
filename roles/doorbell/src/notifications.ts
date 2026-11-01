/**
 * Android notifications from the Google Home app, mirrored to MQTT from a phone.
 * A camera alert carries a JPEG snapshot of the moment it fired, which is a frame
 * the stream may never have been open to grab.
 */
export const CAMERA_NOTIFICATION_TOPIC = 'notify/com.google.android.apps.chromecast.app/posted';

export interface CameraNotification {
    at: Date;
    title: string;
    text: string;
    picture: Buffer;
}

/** Null for anything without a picture: most Home app notifications are not camera alerts. */
export function parseCameraNotification(data: string): CameraNotification | null {
    let message: Record<string, any>;
    try {
        message = JSON.parse(data);
    } catch {
        return null;
    }
    if (typeof message !== 'object' || message === null) return null;
    if (message.hasPicture !== true || typeof message.picture !== 'string' || message.picture === '') return null;

    const picture = Buffer.from(message.picture, 'base64');
    if (picture.length === 0) return null;

    const postTime = Number(message.postTime);

    return {
        // The phone stamps the post; delivery through it and the broker can lag.
        at: Number.isFinite(postTime) && postTime > 0 ? new Date(postTime) : new Date(),
        title: String(message.title ?? ''),
        text: String(message.text ?? ''),
        picture,
    };
}
