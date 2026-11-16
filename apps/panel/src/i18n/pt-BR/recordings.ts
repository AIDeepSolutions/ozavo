const recordings = {
  "title": "Prazo das gravações",
  "lead": "Gravações novas são cifradas em disco e na cópia MinIO/S3. O prazo padrão é 90 dias, com expurgo diário automático. Não extraímos impressão vocal nem fazemos reconhecimento biométrico de voz.",
  "days": "Guardar áudio por (dias)",
  "hint": "De 90 a 3650 dias. O prazo do áudio é independente da transcrição.",
  "save": "Salvar prazo do áudio",
  "confirm": "Apagar gravações com mais de {days} dias?",
  "confirmBody": "O áudio apagado não volta. O expurgo alcança também a cópia MinIO/S3; backups externos precisam seguir o mesmo prazo.",
  "yes": "Confirmar expurgo do áudio",
  "cancel": "Cancelar"
};
export default recordings;
