import importlib.util
import json
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

from study_app import NativeChromeWindowAccess, _open_existing_chrome, launch_service
from study_http import AppError


class Chrome:
    def __init__(self): self.calls = []
    def named_windows(self, name): self.calls.append(('named', name)); return [{'id': 42, 'mode': 'normal'}]
    def open_tab(self, identifier, url, name): self.calls.append(('open', identifier, url, name))


def test_tree_reopens_in_explicit_existing_wind_private_window_without_renaming():
    chrome = Chrome()
    _open_existing_chrome('http://127.0.0.1:1234/tree-targeting/analysis/', chrome=chrome,
                          window_name='Lovefield Wind Study')
    assert chrome.calls == [('named', 'Lovefield Wind Study'), ('open', 42, 'http://127.0.0.1:1234/tree-targeting/analysis/', 'Lovefield Wind Study')]


def test_native_chrome_failure_preserves_the_actual_diagnostic(monkeypatch):
    diagnostic = '91:100: syntax error: Expected end of line but found identifier. (-2741)'
    monkeypatch.setattr('study_app.subprocess.run', lambda arguments, **options:
        subprocess.CompletedProcess(arguments, 1, '', diagnostic + '\n'))
    with pytest.raises(AppError) as raised:
        NativeChromeWindowAccess().named_windows('Lovefield Wind Study')
    assert diagnostic in raised.value.message
    assert raised.value.operation == 'launch'
    assert 'Lovefield Tree Study' not in raised.value.corrective_action
    assert 'permission is missing' not in raised.value.message


def test_native_chrome_failure_preserves_the_operating_system_diagnostic(monkeypatch):
    diagnostic = 'Native automation executable is unavailable'
    def unavailable(arguments, **options):
        raise OSError(diagnostic)
    monkeypatch.setattr('study_app.subprocess.run', unavailable)
    with pytest.raises(AppError) as raised:
        NativeChromeWindowAccess().named_windows('Lovefield Wind Study')
    assert diagnostic in raised.value.message


def test_failed_native_launch_appends_diagnostic_to_existing_service_log(monkeypatch, tmp_path):
    diagnostic = '91:100: syntax error: Expected end of line but found identifier. (-2741)'
    monkeypatch.setattr('study_app.subprocess.run', lambda arguments, **options:
        subprocess.CompletedProcess(arguments, 1, '', diagnostic + '\n'))
    identity = {'url': 'http://127.0.0.1:1234', 'instance_id': 'existing-service'}
    (tmp_path / 'service.json').write_text(json.dumps(identity))
    log = tmp_path / 'service.log'
    log.write_text('Earlier service output\n', encoding='utf-8')
    with pytest.raises(AppError) as raised:
        launch_service({'chrome_window_name': 'Lovefield Wind Study'}, tmp_path,
                       probe=lambda value: value == identity, runtime_check=lambda installation: None)
    retained = log.read_text(encoding='utf-8')
    assert retained.startswith('Earlier service output\n')
    assert diagnostic in retained
    assert 'Lovefield Wind Study' in retained
    assert raised.value.message in retained
    assert raised.value.corrective_action in retained


def test_failed_launch_keeps_original_error_when_log_is_unavailable(monkeypatch, tmp_path, caplog):
    identity = {'url': 'http://127.0.0.1:1234', 'instance_id': 'existing-service'}
    (tmp_path / 'service.json').write_text(json.dumps(identity))
    native_open = Path.open
    def unavailable_log(path, *arguments, **options):
        if path == tmp_path / 'service.log':
            raise OSError('Test log destination is unavailable')
        return native_open(path, *arguments, **options)
    monkeypatch.setattr(Path, 'open', unavailable_log)
    original = AppError('Actual native launch failure', operation='launch')
    def failed_browser(url):
        raise original
    with pytest.raises(AppError) as raised:
        launch_service({'chrome_window_name': 'Lovefield Wind Study'}, tmp_path,
                       probe=lambda value: value == identity, runtime_check=lambda installation: None,
                       browser_open=failed_browser)
    assert raised.value is original
    assert str(tmp_path / 'service.log') in caplog.text
    assert 'Test log destination is unavailable' in caplog.text
    assert original.message in caplog.text


def launcher_builder():
    path = Path(__file__).parents[1] / 'mac/build-launcher.py'
    spec = importlib.util.spec_from_file_location('tree_launcher', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def compiler_fixture(arguments, **options):
    contents = Path(arguments[2]) / 'Contents'
    contents.mkdir(parents=True)
    with (contents / 'Info.plist').open('wb') as metadata:
        plistlib.dump({'CFBundleExecutable': 'applet', 'CFBundleName': 'Compiler name',
                      'CFBundlePackageType': 'APPL',
                      'NSAppleEventsUsageDescription': 'Compiler-provided usage explanation'}, metadata)


def test_installer_retains_explicit_private_window_choice(monkeypatch, tmp_path):
    module = launcher_builder()
    source = tmp_path / 'app.py'; source.write_text('')
    runtime = Path('/Users/denis/projects/denis/lovefield-studies/.venv/bin/python')
    output = tmp_path / 'Tree.app'
    monkeypatch.setattr(module.subprocess, 'run', lambda arguments, **options:
        subprocess.CompletedProcess(arguments, 0, '', ''))
    module.build_launcher(runtime, source, tmp_path / 'data', output, compiler=compiler_fixture,
                          chrome_window_name='Lovefield Wind Study')
    manifest = json.loads((output / 'Contents/Resources/installation.json').read_text())
    assert manifest['runtime'] == str(runtime)
    assert manifest['source'] == str(source)
    assert manifest['chrome_window_name'] == 'Lovefield Wind Study'
    assert manifest['data_directory'] == str(tmp_path / 'data')


@pytest.mark.parametrize('output_name', ['Tree.app', 'Tree Rebuild.app'])
def test_installer_gives_compiled_bundle_stable_tree_identity(monkeypatch, tmp_path, output_name):
    module = launcher_builder()
    source = tmp_path / 'app.py'; source.write_text('')
    monkeypatch.setattr(module.subprocess, 'run', lambda arguments, **options:
        subprocess.CompletedProcess(arguments, 0, '', ''))
    output = module.build_launcher(sys.executable, source, tmp_path / 'data', tmp_path / output_name,
                                   compiler=compiler_fixture, chrome_window_name='Lovefield Wind Study')
    with (output / 'Contents/Info.plist').open('rb') as metadata:
        information = plistlib.load(metadata)
    assert information['CFBundleIdentifier'] == 'love.sourceof.tree-targeting'
    assert information['CFBundleName'] == 'Lovefield Tree Study'
    assert information['CFBundleDisplayName'] == 'Lovefield Tree Study'
    assert information['CFBundleExecutable'] == 'applet'
    assert information['CFBundlePackageType'] == 'APPL'
    assert information['NSAppleEventsUsageDescription'] == 'Compiler-provided usage explanation'


def test_installer_does_not_publish_a_bundle_when_local_signing_fails(monkeypatch, tmp_path):
    module = launcher_builder()
    source = tmp_path / 'app.py'; source.write_text('')
    output = tmp_path / 'Tree.app'
    def unavailable_signer(arguments, **options):
        raise subprocess.CalledProcessError(1, arguments, stderr='Local signing failed')
    monkeypatch.setattr(module.subprocess, 'run', unavailable_signer)
    with pytest.raises(subprocess.CalledProcessError):
        module.build_launcher(sys.executable, source, tmp_path / 'data', output,
                              compiler=compiler_fixture, chrome_window_name='Lovefield Wind Study')
    assert not output.exists()


@pytest.mark.skipif(sys.platform != 'darwin', reason='Native applet compilation and signature verification require macOS')
def test_native_launcher_has_tree_identity_and_valid_signature(tmp_path):
    module = launcher_builder()
    source = tmp_path / 'app.py'; source.write_text('')
    output = module.build_launcher(sys.executable, source, tmp_path / 'data', tmp_path / 'Tree Rebuild.app',
                                   chrome_window_name='Lovefield Wind Study')
    verification = subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(output)],
                                  capture_output=True, text=True, check=False)
    assert verification.returncode == 0, verification.stderr
    with (output / 'Contents/Info.plist').open('rb') as metadata:
        information = plistlib.load(metadata)
    assert information['CFBundleIdentifier'] == 'love.sourceof.tree-targeting'
    assert information['CFBundleName'] == 'Lovefield Tree Study'
    assert information['CFBundleDisplayName'] == 'Lovefield Tree Study'
    details = subprocess.run(['/usr/bin/codesign', '--display', '--verbose=2', str(output)],
                             capture_output=True, text=True, check=False)
    assert details.returncode == 0, details.stderr
    assert 'Identifier=love.sourceof.tree-targeting' in details.stderr
    assert 'Signature=adhoc' in details.stderr
