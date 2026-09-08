"""Explicit development setup and qualification; downloads dependencies, no model.

Uses separate caller-selected checkout and virtualenv directories. Existing source
must match the pin and be clean; never resets, cleans, or advances a checkout.
"""
import argparse
from pathlib import Path
import re
import subprocess
import sys
import venv

from verify_upstream import PINS, verify


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, timeout=600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True, type=Path)
    parser.add_argument('--venv', required=True, type=Path)
    args = parser.parse_args()
    checkout, environment = args.checkout.resolve(), args.venv.resolve()
    if checkout == environment or checkout in environment.parents or environment in checkout.parents:
        raise ValueError('checkout_and_venv_must_be_separate')
    if not checkout.exists():
        run('git', '-c', 'core.autocrlf=false', 'clone', '--no-checkout', PINS['repository'], checkout)
        run('git', '-C', checkout, '-c', 'core.autocrlf=false', 'checkout', '--detach', PINS['commit'])
    verify(checkout)
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    # Constraints cannot contain upstream's editable relative-path requirements.
    # Retain its exact third-party pins and install only the two required sibling packages.
    constraints = environment / 'upstream-constraints.txt'
    pins = [line for line in (checkout / 'requirements.txt').read_text().splitlines()
            if re.fullmatch(r'[A-Za-z0-9_-]+==[^\s]+', line)]
    if 'claude-agent-sdk==0.2.139' not in pins:
        raise ValueError('python_sdk_pin_mismatch')
    constraints.write_text('\n'.join(pins) + '\n', encoding='utf-8')
    run(python, '-m', 'pip', 'install', '-c', constraints,
        checkout / 'commerce-common', checkout / 'merchant-agent/core', 'claude-agent-sdk==0.2.139')
    run(python, '-m', 'pip', 'check')
    here = Path(__file__).resolve().parent
    run(python, here / 'upstream_conformance.py', '--checkout', checkout)
    run(python, here / 'sdk_conformance.py')


if __name__ == '__main__':
    main()
