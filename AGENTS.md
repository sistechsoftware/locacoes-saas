# AGENTS.md

## Fluxo Git padrão (obrigatório)

Nunca commitar nem dar push direto em `main`. Para cada mudança:

1. **Atualizar a main**
   ```bash
   git switch main && git pull --ff-only origin main
   ```
2. **Criar branch nova a partir da main** — uma branch = um objetivo/pendência
   ```bash
   git switch -c <tipo>/<nome-curto>
   ```
   Tipos: `fix`, `feat`, `test`, `chore`, `docs`, `refactor`, `audit`.
   Ex.: `fix/assinatura-gate`, `audit/push-multi-tenant`.
3. **Commit local** com mensagem convencional, em português:
   ```
   <tipo>: <o que muda e por quê> — (pendência #NN)
   ```
4. **Push da MESMA branch** para o remoto:
   ```bash
   git push -u origin <branch>
   ```
5. **Abrir PR para `main`.**
   - Sem `gh` instalado: abrir
     `https://github.com/sistechsoftware/locacoes-saas/compare/main...<branch>`
     e clicar em "Create pull request".
   - Com `gh`: `gh pr create --base main --head <branch> --title "..." --body "..."`
6. **Merge SÓ via PR e só com aprovação explícita do usuário.** O agente nunca
   faz merge em `main` (nem local, nem remoto) sem pedido. Merge com `--no-ff`
   para o histórico registrar a branch de origem.
7. **Limpeza após o merge:** apagar a branch local e remota
   ```bash
   git branch -d <branch>
   git push origin --delete <branch>
   ```

### Regras de ouro

- Commit, push, PR e merge **somente quando o usuário pedir**.
- Verificar o estado antes de qualquer operação:
  - `git branch --merged main` → o que **já está** na main;
  - `git branch --no-merged main` → o que **falta**;
  - `git status -sb` → branch atual e se está sincronizada com o remoto.
- Antes de commitar: `npx tsc --noEmit`, `npm test` e `npm run build` verdes
  (capturar o exit real, não só a saída filtrada).
- Antes de merge entre branches irmãs: `git merge-tree --write-tree <a> <b>`
  para detectar conflito sem tocar no working tree.
- Preferir uma branch por pendência; não misturar assuntos.
