interface Message {
  to: string;
  title: string;
  body: string;
  sound: string;
}

export default ({ filter, action }, { database, logger }) => {
  filter("notifications.items.create", () => {
    console.log("📲 ¡Nueva notificación");
  });

  action("notifications.items.create", async ({ payload }) => {
    const EXPO_API_URL = "https://exp.host/--/api/v2/push/send";
    console.log({ payload });
    const { title, body, type, event } = payload;

    try {
      // 🔹 1. Reset tokens
      await resetTokens(database, logger);

      // 🔹 2. Obtener tokens válidos
      const validTokens = await getValidTokens(database, logger);
      if (!validTokens.length) return;

      // 🔹 3. Preparar mensajes
      const messages: Message[] = validTokens.map((to) => ({
        to,
        title,
        body,
        data: { type, event },
        sound: "default",
      }));

      // 🔹 4. Enviar mensajes por batches
      const { sentTokens, invalidTokens } = await sendBatches(
        messages,
        EXPO_API_URL,
        logger
      );

      // 🔹 5. Actualizar tokens enviados
      if (sentTokens.length) {
        await markTokensNotified(database, sentTokens);
        logger.info(
          `✅ Actualizados ${sentTokens.length} tokens como notificados`
        );
      }

      // 🔹 6. Manejar tokens inválidos (actualizar a draft)
      if (invalidTokens.length) {
        await database("notifications_tokens")
          .whereIn("expoPushToken", invalidTokens)
          .update({ notified: false, status: "draft" });
        logger.info(
          `🧹 ${invalidTokens.length} tokens con error actualizados a status "draft"`
        );
      }

      logger.info(
        `✅ Notificación enviada a ${validTokens.length} dispositivos.`
      );
    } catch (error) {
      console.error("Error al enviar notificaciones:", error);
    }
  });
};

// ---------------- Helper functions ----------------
async function resetTokens(database, logger) {
  await database("notifications_tokens").update({ notified: false });
  logger.info("🔄 Marcados todos los tokens como 'Sin notificar'");
}

async function getValidTokens(database, logger): Promise<string[]> {
  const tokens = await database("notifications_tokens")
    .select("expoPushToken")
    .where("isForTest", true)
    .where("status", "published");

  const validTokens = tokens
    .map((t) => t.expoPushToken)
    .filter((t) => t.startsWith("ExponentPushToken"));

  logger.info(`🔹 ${validTokens.length} tokens válidos encontrados`);
  return validTokens;
}

async function sendBatches(messages: Message[], url: string, logger) {
  const batchSize = 100;
  const sentTokens: string[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const chunk = messages.slice(i, i + batchSize);

    let result;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      result = await res.json();
    } catch (e) {
      logger.error("❌ Error en fetch:", e);
      continue;
    }

    result.data?.forEach((res, index) => {
      const token = chunk[index].to;
      if (res.status === "ok") {
        sentTokens.push(token);
      } else {
        // Cualquier error marca el token como inválido
        const error = res.details?.error || res.message || "Error desconocido";
        logger.warn(`❌ Token con error (${error}): ${token}`);
        invalidTokens.push(token);
      }
    });
  }

  return { sentTokens, invalidTokens };
}

async function markTokensNotified(database, tokens: string[]) {
  await database("notifications_tokens")
    .whereIn("expoPushToken", tokens)
    .update({ notified: true });
}
