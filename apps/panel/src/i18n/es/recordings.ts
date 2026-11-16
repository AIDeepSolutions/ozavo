const recordings = {
  "title": "Plazo de las grabaciones",
  "lead": "Las grabaciones nuevas se cifran en disco y en la copia MinIO/S3. El plazo predeterminado es de 90 días con borrado diario automático. No extraemos huellas vocales ni realizamos biometría de voz.",
  "days": "Conservar audio durante (días)",
  "hint": "De 90 a 3650 días. El plazo del audio es independiente de las transcripciones.",
  "save": "Guardar plazo del audio",
  "confirm": "¿Borrar grabaciones de más de {days} días?",
  "confirmBody": "El audio borrado no vuelve. El borrado incluye la copia MinIO/S3; las copias externas deben seguir el mismo plazo.",
  "yes": "Confirmar borrado del audio",
  "cancel": "Cancelar"
};
export default recordings;
