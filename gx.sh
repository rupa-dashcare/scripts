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
    flatten    Flatten last N commits into one using rebase
    gcom       Commit staged changes with a labeled commit message locally
    gcu        Checkout: Switch your current clone to point at another branch
    gcub       Create a new branch and push local code to server
    glog       Show git log with graph and pretty printing
    gpu        Push current branch to server
    gpuf       Force push current branch to server
    pullhard   Fetch and reset current branch to origin/<branch> on server
    sad        Add all changes to staged list
    so         Show git status, what branch you're on, and changes
    stomp      Force push current branch to destination branch on server
    help       Show this message

Examples:
    gx flatten <number>
    gx gcom "commit message"
    gx gcu <branchname>
    gx gcub <branchname>
    gx glog [num_lines]
    gx gpu
    gx gpuf
    gx pullhard
    gx sad
    gx so
    gx stomp <branchname>
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

    local line_count="${1:-20}"

    run_cmd git log -n "$line_count" --pretty=tformat:"%C(auto)%H %C(green) %ad%x08%x08%x08%x08%x08%x08%C(reset)%C(auto) | %s%d %C(cyan)[%aE]%C(reset)" --graph --date=iso-local
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

gcu() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    if [[ -z "${1-}" ]]; then
        echo "Error: branch name is required." >&2
        return 1
    fi

    local branch_name="$1"

    echo "Checking out branch: $branch_name"
    run_cmd git checkout "$branch_name"

    echo ""
    so
}

gcub() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    if [[ -z "${1-}" ]]; then
        echo "Error: branch name is required." >&2
        return 1
    fi

    local branch_name="$1"

    echo "Creating and checking out branch: $branch_name"
    run_cmd git checkout -b "$branch_name"

    echo "Pushing $branch_name to origin..."
    run_cmd git push -u origin "$branch_name"

    echo "Successfully created and pushed branch $branch_name"
}

stomp() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    if [[ -z "${1-}" ]]; then
        echo "Error: branch name is required." >&2
        return 1
    fi

    local destination_branch="$1"
    local current_branch
    if ! current_branch=$(current_branch); then
        echo "Error: could not determine current branch (detached HEAD?)." >&2
        return 3
    fi

    echo "WARNING: About to force push current branch '$current_branch' over destination branch '$destination_branch'"
    
    echo "Force pushing $current_branch to $destination_branch..."
    run_cmd git push origin "$current_branch:$destination_branch" --force

    echo "Successfully stomped $destination_branch with $current_branch"
}

flatten() {
    # Ensure inside a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: not a git repository." >&2
        return 2
    fi

    if [[ -z "${1-}" ]]; then
        echo "Error: number of commits to flatten is required." >&2
        return 1
    fi

    local num_commits="$1"

    # Validate that the argument is a number
    if ! [[ "$num_commits" =~ ^[0-9]+$ ]]; then
        echo "Error: number of commits must be a positive integer." >&2
        return 1
    fi

    # Need at least 2 commits to flatten
    if (( num_commits < 2 )); then
        echo "Error: need at least 2 commits to flatten." >&2
        return 1
    fi

    echo "Flattening last $num_commits commits..."
    
    # Get the commit message from the oldest commit in the range (which will be HEAD~(num_commits-1))
    local commit_message
    commit_message=$(git log -1 --pretty=%B "HEAD~$((num_commits - 1))")
    
    # Use git rebase to squash all commits
    # The approach: reset to the commit before our range, then recommit everything
    local base_commit
    base_commit=$(git rev-parse "HEAD~$num_commits")
    
    echo "Resetting to base commit..."
    run_cmd git reset --soft "$base_commit"
    
    echo "Re-committing with message from oldest commit..."
    run_cmd git commit -m "$commit_message"
    
    echo "Successfully flattened last $num_commits commits"
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
    gcu)
        gcu "$@"
        exit 0
        ;;
    gcom)
        gcom "$@"
        exit 0
        ;;
    gcub)
        gcub "$@"
        exit 0
        ;;
    stomp)
        stomp "$@"
        exit 0
        ;;
    flatten)
        flatten "$@"
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

