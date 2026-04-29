export type Shell = 'bash' | 'zsh' | 'fish';

export function isSupportedShell(value: string): value is Shell {
  return value === 'bash' || value === 'zsh' || value === 'fish';
}

export function renderCompletion(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return bashScript();
    case 'zsh':
      return zshScript();
    case 'fish':
      return fishScript();
  }
}

function bashScript(): string {
  return `# way bash completion
# Install:
#   way completions bash > /usr/local/etc/bash_completion.d/way
#   # or: way completions bash >> ~/.bashrc

_way() {
  local cur prev words cword
  _init_completion || return

  # Complete the first positional with workflow names.
  local i pos=0
  for (( i=1; i < cword; i++ )); do
    case "\${words[i]}" in
      -*) ;;
      --) break ;;
      *) pos=$((pos+1)) ;;
    esac
  done

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "-h --help -V --version -l --list --verbose --plain" -- "$cur") )
    return
  fi

  if [[ $pos -eq 0 ]]; then
    local names
    names=$(way --list 2>/dev/null | awk '{print $1}')
    COMPREPLY=( $(compgen -W "$names validate completions" -- "$cur") )
    return
  fi

  if [[ $pos -eq 1 && "\${words[1]}" == validate ]]; then
    local names
    names=$(way --list 2>/dev/null | awk '{print $1}')
    COMPREPLY=( $(compgen -W "$names" -- "$cur") )
  fi
}
complete -F _way way
`;
}

function zshScript(): string {
  return `#compdef way
# way zsh completion
# Install:
#   way completions zsh > "\${fpath[1]}/_way"
#   # then restart your shell or run: compinit

_way() {
  local -a workflows
  workflows=(\${(f)"$(way --list 2>/dev/null | awk '{print $1}')"})

  _arguments -C \\
    '(-h --help)'{-h,--help}'[show help]' \\
    '(-V --version)'{-V,--version}'[show version]' \\
    '(-l --list)'{-l,--list}'[list available workflows]' \\
    '--verbose[print outputs JSON after completion]' \\
    '--plain[disable the live TUI]' \\
    '1:workflow:($workflows)' \\
    '*::arg:_files'
}
_way "$@"
`;
}

function fishScript(): string {
  return `# way fish completion
# Install:
#   way completions fish > ~/.config/fish/completions/way.fish

function __way_workflows
  way --list 2>/dev/null | awk '{print $1}'
end

function __way_needs_name
  set -l tokens (commandline -opc)
  set -e tokens[1]
  for t in $tokens
    string match -q -- '-*' $t; and continue
    return 1
  end
  return 0
end

complete -c way -f
complete -c way -n __way_needs_name -a '(__way_workflows)' -d workflow
complete -c way -s h -l help        -d 'show help'
complete -c way -s V -l version     -d 'show version'
complete -c way -s l -l list        -d 'list available workflows'
complete -c way      -l verbose     -d 'print outputs JSON after completion'
complete -c way      -l plain       -d 'disable the live TUI'
`;
}
