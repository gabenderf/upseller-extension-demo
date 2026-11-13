# Extensão UpSeller: produtividade da expedição

> **Cópia pública de demonstração.** O código é o mesmo do sistema em uso na expedição da Hope Cirúrgica, publicado para consulta. Ficaram de fora a documentação interna de operação e segurança e qualquer dado real: nenhuma URL ou chave de banco acompanha o repositório, e os dados de exemplo são fictícios. Veja o sistema rodando em modo demonstração no [portfólio](https://gabeand.ia.br).

Extensão do Chrome (Manifest V3) que roda nas bancadas de expedição da Hope, dentro do UpSeller.
Cada etiqueta bipada vira um registro no Supabase com operador, pedido e itens, e um painel flutuante
mostra ao operador o ritmo dele contra a meta do dia em tempo real.

Faz parte do sistema de expedição da Hope, junto com o coletor de dados da fila e o painel da
liderança (Hope SaaS), que lê esses registros para o ranking, os relatórios e a previsão.

## O que tem de interessante

- **Leitura da bipagem dentro de um sistema de terceiros**: o content script observa a tela de
  checkout do UpSeller e extrai pedido, rastreio e itens sem integração oficial.
- **Meta global ajustável**: a liderança muda a meta do dia no painel e todas as bancadas seguem,
  sem reinstalar nada.
- **Credencial própria por máquina**: pareamento por código aprovado por um admin, sessão do
  Supabase Auth com renovação rotativa e alarme que mantém a sessão viva mesmo sem bipagem.
  Depois de pareada, nunca volta para a chave compartilhada.
- **Testes de ponta a ponta** com Chrome headless contra um projeto Supabase de teste, incluindo o
  service worker encerrado e acordado pelos alarmes.

## Instalação

1. Copie `config.example.js` para `config.js` e preencha a URL e a chave do Supabase.
2. Em `chrome://extensions`, ative o modo de desenvolvedor e use **Carregar sem compactação** nesta pasta.
3. No popup, **Parear** e aprove o código no Hope SaaS (Configurações > Dispositivos).

`test_upseller.html` simula a tela do UpSeller para testar sem o site real.
