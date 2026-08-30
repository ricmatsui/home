import { SessionExpiredError } from '../lib/errors';

type ErrorBannerProps = {
    error: Error;
    onReload: () => void;
    onRetry: () => void;
};

export function ErrorBanner({ error, onReload, onRetry }: ErrorBannerProps) {
    const expired = error instanceof SessionExpiredError;

    return (
        <div className="banner" role="alert">
            <p className="banner__message">{expired ? 'Session expired.' : error.message}</p>
            <button type="button" className="banner__action" onClick={expired ? onReload : onRetry}>
                {expired ? 'Reload' : 'Retry'}
            </button>
        </div>
    );
}
