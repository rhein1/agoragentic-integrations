"""One explicit local fixture in, an offline packet/replay out. No apply mode."""
import json
import os
import stat
import sys
from domain.contract import ContractError, compile_packet, fields, history_proposal, replay


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ContractError("duplicate_json_key")
        result[key] = value
    return result


def load(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ContractError("regular_file_required")
        with os.fdopen(fd, "rb", closefd=False) as source:
            raw = source.read(262145)
        if len(raw) > 262144:
            raise ContractError("fixture_too_large")
    finally:
        os.close(fd)
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ContractError("nonfinite_number")))


def main(argv):
    try:
        if len(argv) != 1 or argv[0].startswith("-"):
            raise ContractError("usage_preview_one_fixture_json")
        fixture = load(argv[0])
        fields(fixture, "request observations")
        result = {"packet": compile_packet(fixture["request"]),
                  "replay": replay(fixture["request"], fixture["observations"]),
                  "history_proposal": history_proposal(fixture["request"], fixture["observations"])}
        print(json.dumps(result, indent=2, allow_nan=False))
        return 0
    except ContractError as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, UnicodeError, RecursionError, TypeError):
        print("invalid_or_unreadable_fixture", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
