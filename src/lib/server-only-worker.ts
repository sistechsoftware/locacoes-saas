/**
 * Substituto de "server-only" no pacote do Worker.
 *
 * O guarda "server-only" existe para o Next barrar um modulo de servidor que
 * vaze para o cliente, e ele faz isso lancando erro quando e resolvido fora da
 * condicao react-server. O wrangler empacota o custom-worker.ts sem essa
 * condicao, entao o guarda disparava no cron e derrubava a rotina antes da
 * primeira linha rodar.
 *
 * Aqui ele vira um modulo vazio: no Worker nao existe cliente para proteger, e
 * o build do Next continua usando o pacote de verdade, com a protecao intacta.
 */
export {};
