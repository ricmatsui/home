import json
import logging
import os
from pathlib import Path

import flask

from app.control import TvControl
from app.recordings import Recordings

ROOT = Path(__file__).parent.parent


def create_app(control=None, recordings=None, static=None):
    logging.basicConfig(format='%(message)s', level=logging.DEBUG)

    app = flask.Flask(__name__, root_path=str(ROOT))
    app.logger.setLevel(logging.DEBUG)

    if recordings is None:
        recordings = Recordings(
            Path(os.environ.get('RECORDINGS_PATH', '/data/recordings.jsonl'))
        )

    if control is None:
        control = TvControl(
            ip=os.environ['REMOTE_TV_IP'],
            mac=os.environ['REMOTE_TV_MAC'],
            token=os.environ['REMOTE_TV_TOKEN'],
            lan_cidr=os.environ['REMOTE_LAN_CIDR'],
        )
        control.start()

    # Tests pass an isolated static root; production uses Flask's own.
    static = Path(static) if static else Path(app.static_folder)

    @app.route('/')
    def index():
        return flask.render_template('index.html')

    @app.route('/control', methods=['POST'])
    def post_control():
        message = json.loads(flask.request.form.get('message'))
        app.logger.debug('= control: %s', json.dumps(message))
        control.send(message)
        return flask.Response(status=204)

    @app.route('/record', methods=['POST'])
    def post_record():
        recordings.append(
            flask.request.form.get('gesture'),
            flask.request.form.get('image'),
        )
        return flask.Response(status=204)

    @app.route('/delete', methods=['POST'])
    def post_delete():
        recordings.delete_last()
        return flask.Response(status=204)

    @app.route('/gestures.json')
    def gestures_json():
        response = flask.make_response(flask.send_file(static / 'gestures.json'))
        response.cache_control.max_age = None
        response.cache_control.no_cache = True
        return response

    @app.route('/model/<path:filename>')
    def model(filename):
        response = flask.make_response(
            flask.send_from_directory(static / 'model', filename)
        )
        response.cache_control.max_age = None
        response.cache_control.no_cache = True
        return response

    @app.route('/favicon.png')
    def favicon():
        return flask.send_from_directory(static, 'favicon.png')

    @app.route('/favicon-192.png')
    def favicon192():
        return flask.send_from_directory(static, 'favicon-192.png')

    @app.route('/help.jpg')
    def help_image():
        return flask.send_from_directory(static, 'help.jpg')

    @app.route('/manifest.json')
    def manifest():
        return flask.send_from_directory(static, 'manifest.json')

    return app
