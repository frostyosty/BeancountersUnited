#!/bin/sh

set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "🎨 Starting acct Icon Studio..."

# Runs the Python in PY_FOUND ("py -3" is Windows' launcher).
run_python() {
    case "$PY_FOUND" in
        "py -3") py -3 "$@" ;;
        *) "$PY_FOUND" "$@" ;;
    esac
}

# True when PY_FOUND is a Python 3 that runs. On Windows `python3` and `python` can be the
# Microsoft Store shortcut: it is on PATH, but all it does is print "Python was not found".
works() {
    run_python -c "import sys; sys.exit(sys.version_info < (3, 8))" >/dev/null 2>&1
}

# The folder of a Windows variable such as LOCALAPPDATA, the way this shell writes paths.
win_dir() {
    [ -n "$1" ] || return 0
    cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
}

# Leaves the Python to use in PY_FOUND, or fails.
find_python() {
    for PY_FOUND in ${PYTHON:+"$PYTHON"} python3 python "py -3"; do
        if works; then return 0; fi
    done
    # A Python installed a moment ago isn't on this shell's PATH yet: look where Windows puts it.
    for PY_FOUND in "$(win_dir "$LOCALAPPDATA")"/Programs/Python/Python3*/python.exe "$(win_dir "$PROGRAMFILES")"/Python3*/python.exe; do
        if [ -f "$PY_FOUND" ] && works; then return 0; fi
    done
    return 1
}

if ! find_python; then
    case "$(uname -s)" in
        MINGW* | MSYS* | CYGWIN*)
            if command -v winget >/dev/null 2>&1; then
                echo "🐍 Python is missing. Installing it with winget..."
                winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements \
                    || winget install -e --id Python.Python.3.13 --accept-package-agreements --accept-source-agreements \
                    || true
            fi
            ;;
    esac
    if ! find_python; then
        echo "❌ Python 3 is not installed."
        echo "   Get it from https://www.python.org/downloads/ and run this again."
        exit 1
    fi
fi

# Check/install Pillow
if ! run_python -c "import PIL" >/dev/null 2>&1; then
    echo "📦 Pillow is missing. Installing it..."
    run_python -m pip install Pillow
fi

# Start the Python server
run_python "$SCRIPT_DIR/tools/icon-studio/icon_studio.py"
