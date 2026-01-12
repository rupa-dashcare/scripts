#!/usr/bin/env bash

# Setup notes — how to install `gx` on a new Linux machine
# -------------------------------------------------------
# 1) Make the script executable (required):
#    chmod +x /path/to/gx.sh
# 2) Per-user alias (keeps script in-place):
#    # Bash (append to ~/.bash_aliases):
#    echo "alias gx='/path/to/gx.sh'" >> ~/.bash_aliases
#    # Zsh (append to ~/.zshrc):
#    echo "alias gx='/path/to/gx.sh'" >> ~/.zshrc
#    # Then reload your shell:
#    source ~/.bash_aliases    # or: source ~/.zshrc
#
# 3) System-wide (symlink) — makes `gx` available on $PATH:
#    sudo ln -s /path/to/gx.sh /usr/local/bin/gx
#
# Notes:
# - Replace /path/to/gx.sh with the actual absolute path to this file.
# - Symlinking is convenient because you don't need to source dotfiles.
# - Avoid editing system files unless you understand the permission change.
# -------------------------------------------------------

set -euo pipefail

SCRIPT_NAME=$(basename "$0")

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME <subcommand> [args]

Subcommands:
    pullhard   Fetch and reset current branch to origin/<branch>
    glog       Show git log with graph and pretty printing
    gpu        Push current branch to origin
    gpuf       Force push current branch to origin
    sad        Add all changes
    gcom       Commit with a message
    so         Show git status
    help       Show this message

Examples:
    gx pullhard
    gx glog
    gx gpu
    gx gpuf
    gx sad
    gx gcom "commit message"
    gx so
EOF
}

current_branch() {
    # Returns the current branch name, or exits non-zero if detached/unknown
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
        return 1
    fi
    printf '%s' "$branch"
}

run_cmd() {
    # Print the command prefixed with '>> ' then execute it.
    # Usage: run_cmd git fetch origin
    printf '>> %s\n' "$*"
    # Execute the command and preserve exit code
    "$@"
}

pullhard() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    local branch
    if ! branch=$(current_branch); then
        echo "Error: could not determine current branch (detached HEAD?)." >&2
        return 3
    fi

    echo "Fetching origin..."
    run_cmd git fetch origin

    echo "Resetting to origin/$branch (hard)..."
    run_cmd git reset --hard "origin/$branch"

    echo "Successfully reset to origin/$branch"
    echo ""
    so
}

glog() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    run_cmd git log --pretty=tformat:"%C(auto)%H %C(green) %ad%x08%x08%x08%x08%x08%x08%C(reset)%C(auto) | %s%d %C(cyan)[%aE]%C(reset)" --graph --date=iso-local
}

gpu() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    local branch
    if ! branch=$(current_branch); then
        echo "Error: could not determine current branch (detached HEAD?)." >&2
        return 3
    fi

    echo "Pushing $branch to origin..."
    run_cmd git push origin "$branch"

    echo "Successfully pushed $branch"
}

gpuf() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    local branch
    if ! branch=$(current_branch); then
        echo "Error: could not determine current branch (detached HEAD?)." >&2
        return 3
    fi

    echo "Force pushing $branch to origin..."
    run_cmd git push --force origin "$branch"

    echo "Successfully force pushed $branch"
}

gcom() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    if [[ -z "${1-}" ]]; then
        echo "Error: commit message is required." >&2
        return 1
    fi

    local message="$1"

    echo "Committing with message: \"$message\""
    run_cmd git commit -m "$message"

    echo "Successfully committed"
}

sad() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    echo "Adding all changes..."
    run_cmd git add .

    echo "Successfully added all changes"
    echo ""
    so
}

so() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    run_cmd git status
}

# Dispatch subcommands
if [[ ${1-} == "" ]]; then
    usage
    exit 1
fi

cmd="$1"
shift || true

case "$cmd" in
    pullhard)
        pullhard "$@"
        exit 0
        ;;
    glog)
        glog "$@"
        exit 0
        ;;
    gpu)
        gpu "$@"
        exit 0
        ;;
    gpuf)
        gpuf "$@"
        exit 0
        ;;
    sad)
        sad "$@"
        exit 0
        ;;
    so)
        so "$@"
        exit 0
        ;;
    gcom)
        gcom "$@"
        exit 0
        ;;
    help|-h|--help)
        usage
        exit 0
        ;;
    *)
        echo "Unknown subcommand: $cmd" >&2
        usage
        exit 2
        ;;
esac
#!/usr/bin/env bash

# Setup notes — how to install `gx` on a new Linux machine
# -------------------------------------------------------
# 1) Make the script executable (required):
#    chmod +x /path/to/gx.sh
#
# 2) Per-user alias (keeps script in-place):
#!/usr/bin/env bash

# Setup notes — how to install `gx` on a new Linux machine
# -------------------------------------------------------
# 1) Make the script executable (required):
#    chmod +x /path/to/gx.sh
#
# 2) Per-user alias (keeps script in-place):
#    # Bash (append to ~/.bash_aliases):
#    echo "alias gx='/path/to/gx.sh'" >> ~/.bash_aliases
#    # Zsh (append to ~/.zshrc):
#    echo "alias gx='/path/to/gx.sh'" >> ~/.zshrc
#    # Then reload your shell:
#    source ~/.bash_aliases    # or: source ~/.zshrc
#
# 3) System-wide (symlink) — makes `gx` available on $PATH:
#    sudo ln -s /path/to/gx.sh /usr/local/bin/gx
#
# Notes:
# - Replace /path/to/gx.sh with the actual absolute path to this file.
# - Symlinking is convenient because you don't need to source dotfiles.
# - Avoid editing system files unless you understand the permission change.
# -------------------------------------------------------

set -euo pipefail

SCRIPT_NAME=$(basename "$0")

usage() {
	cat <<EOF
Usage: $SCRIPT_NAME <subcommand> [args]

Subcommands:
	pullhard   Fetch and reset current branch to origin/<branch>
	help       Show this message

Examples:
	gx pullhard
EOF
}

current_branch() {
	# Returns the current branch name, or exits non-zero if detached/unknown
	local branch
	branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
	if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
		return 1
	fi
	printf '%s' "$branch"
}

run_cmd() {
	# Print the command prefixed with '>> ' then execute it.
	# Usage: run_cmd git fetch origin
	printf '>> %s\n' "$*"
	# Execute the command and preserve exit code
	"$@"
}

pullhard() {
	# Ensure inside a git repository
	if ! git rev-parse --git-dir >/dev/null 2>&1; then
		echo "Error: not a git repository." >&2
		return 2
	fi

	local branch
	if ! branch=$(current_branch); then
		echo "Error: could not determine current branch (detached HEAD?)." >&2
		return 3
	fi

	echo "Fetching origin..."
	run_cmd git fetch origin

	echo "Resetting to origin/$branch (hard)..."
	run_cmd git reset --hard "origin/$branch"

	echo "Successfully reset to origin/$branch"
}

# Dispatch subcommands
if [[ ${1-} == "" ]]; then
	usage
	exit 1
fi

cmd="$1"
shift || true

case "$cmd" in
	pullhard)
		pullhard "$@"
		;;
	help|-h|--help)
		usage
		;;
	*)
		echo "Unknown subcommand: $cmd" >&2
		usage
		exit 2
		;;
esac

	pullhard   Fetch and reset current branch to origin/<branch>
	help       Show this message

Examples:
	gx pullhard
EOF
}

current_branch() {
	# Returns the current branch name, or exits non-zero if detached/unknown
	local branch
	branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
	if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
		return 1
	fi
	printf '%s' "$branch"
}

run_cmd() {
	# Print the command prefixed with '>> ' then execute it.
	# Usage: run_cmd git fetch origin
	printf '>> %s\n' "$*"
	# Execute the command and preserve exit code
	"$@"
}

pullhard() {
	# Ensure inside a git repository
	if ! git rev-parse --git-dir >/dev/null 2>&1; then
		echo "Error: not a git repository." >&2
		return 2
	fi

	local branch
	if ! branch=$(current_branch); then
		echo "Error: could not determine current branch (detached HEAD?)." >&2
		return 3
	fi

	echo "Fetching origin..."
	run_cmd git fetch origin

	echo "Resetting to origin/$branch (hard)..."
	run_cmd git reset --hard "origin/$branch"

	echo "Successfully reset to origin/$branch"
}

# Dispatch subcommands
if [[ ${1-} == "" ]]; then
	usage
	exit 1
fi

cmd="$1"
shift || true

case "$cmd" in
	pullhard)
		pullhard "$@"
		;;
	help|-h|--help)
		usage
		;;
	*)
		echo "Unknown subcommand: $cmd" >&2
		usage
		exit 2
		;;
esac

