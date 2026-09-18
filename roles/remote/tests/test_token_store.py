from app.token_store import TokenStore


def test_read_returns_none_when_never_paired(tmp_path):
    assert TokenStore(tmp_path / 'token').read() is None


def test_write_then_read_round_trips(tmp_path):
    store = TokenStore(tmp_path / 'token')

    store.write('12345678')

    assert store.read() == '12345678'


def test_read_ignores_surrounding_whitespace(tmp_path):
    """A token seeded by hand with `echo` picks up a trailing newline."""
    path = tmp_path / 'token'
    path.write_text('12345678\n')

    assert TokenStore(path).read() == '12345678'


def test_read_treats_an_empty_file_as_unpaired(tmp_path):
    path = tmp_path / 'token'
    path.write_text('')

    assert TokenStore(path).read() is None


def test_write_creates_the_parent_directory(tmp_path):
    store = TokenStore(tmp_path / 'data' / 'token')

    store.write('12345678')

    assert store.read() == '12345678'


def test_write_replaces_an_earlier_token(tmp_path):
    store = TokenStore(tmp_path / 'token')

    store.write('12345678')
    store.write('87654321')

    assert store.read() == '87654321'


def test_write_leaves_no_partial_files_behind(tmp_path):
    """The store writes to gluster; a torn file is worse than no file."""
    store = TokenStore(tmp_path / 'token')

    store.write('12345678')

    assert [path.name for path in tmp_path.iterdir()] == ['token']


def test_clear_makes_the_store_unpaired_again(tmp_path):
    store = TokenStore(tmp_path / 'token')
    store.write('12345678')

    store.clear()

    assert store.read() is None


def test_clear_is_a_no_op_when_never_paired(tmp_path):
    TokenStore(tmp_path / 'token').clear()
