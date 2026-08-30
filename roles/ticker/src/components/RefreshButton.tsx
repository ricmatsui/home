type RefreshButtonProps = {
    onRefresh: () => void;
    loading: boolean;
};

export function RefreshButton({ onRefresh, loading }: RefreshButtonProps) {
    return (
        <button type="button" className="control" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
        </button>
    );
}
