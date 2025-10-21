import { MessageUpsertType, proto, WASocket } from "@whiskeysockets/baileys";
import {
  convertTextToSpeechAndSaveToFile,
  getBodyMessage,
  keepOnlySpecifiedChars,
  transferQueue,
  verifyMediaMessage,
  verifyMessage
} from "../WbotServices/wbotMessageListener";
import { ChatCompletionTool } from "openai/resources/chat/completions";
import fs from "fs";
import path from "path";

import OpenAI from "openai";
import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import Message from "../../models/Message";
import TicketTraking from "../../models/TicketTraking";
import Prompt from "../../models/Prompt";
import Queue from "../../models/Queue";
import Tag from "../../models/Tag";
import TicketTag from "../../models/TicketTag";
import TicketNote from "../../models/TicketNote";
import User from "../../models/User";
import { getIO } from "../../libs/socket";
import ContactTag from "../../models/ContactTag";

type Session = WASocket & {
  id?: number;
};

interface IOpenAi {
  name: string;
  prompt: string;
  voice: string;
  voiceKey: string;
  voiceRegion: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
  queueId: number;
  maxMessages: number;
}

const sessionsOpenAi: (OpenAI & { id?: number })[] = [];

const deleteFileSync = (path: string): void => {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    console.error("Erro ao deletar o arquivo:", error);
  }
};

const sanitizeName = (name: string): string => {
  let sanitized = name.split(" ")[0];
  sanitized = sanitized.replace(/[^a-zA-Z0-9]/g, "");
  return sanitized.substring(0, 60);
};

const tools: ChatCompletionTool[] = [
  {
    type: "function" as "function",
    function: {
      name: "transfer_queue",
      description: "Transfere o ticket para uma fila específica.",
      parameters: {
        type: "object",
        properties: {
          queue: {
            type: "string",
            description: "Nome exato da fila para transferir."
          }
        },
        required: ["queue"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "add_tag",
      description: "Adiciona uma ou mais tags ao ticket e uma observação.",
      parameters: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Lista de nomes exatos das tags a adicionar."
          },
          note: {
            type: "string",
            description: "Observação relevante sobre o atendimento."
          }
        },
        required: ["tags"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "transfer_user",
      description: "Transfere o ticket para um usuário específico.",
      parameters: {
        type: "object",
        properties: {
          user: {
            type: "string",
            description: "Nome exato do usuário para transferir."
          }
        },
        required: ["user"],
        additionalProperties: false
      }
    }
  }
];

// Função para extrair JSON de ações do final da resposta da IA
const extractAIActions = (response: string): any => {
  const jsonMatch = response.match(/\{[\s\S]*\}$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.log("extractAIActions - erro ao parsear JSON:", e);
      return null;
    }
  }
  return null;
};

const processAIActions = async (
  aiActions: any,
  ticket: Ticket,
  contact: Contact,
  availableTags: string[],
  availableUsers: string[]
) => {
  // 1. Transferência automática de fila
  if (aiActions?.queue) {
    const queueName = aiActions.queue.trim();
    if (queueName) {
      const queue = await Queue.findOne({
        where: { name: queueName, companyId: ticket.companyId }
      });
      if (queue && queue.id !== ticket.queueId) {
        await transferQueue(queue.id, ticket, contact);
      }
    }
  }

  // 2. Adicionar tags automaticamente
  if (Array.isArray(aiActions?.tags) && aiActions.tags.length > 0) {
    const validTags = aiActions.tags.filter((tag: string) =>
      availableTags.includes(tag)
    );
    if (validTags.length > 0) {
      const tags = await Tag.findAll({
        where: {
          name: validTags,
          companyId: ticket.companyId
        }
      });
      for (const tag of tags) {
        await TicketTag.findOrCreate({
          where: { ticketId: ticket.id, tagId: tag.id }
        });
      }
      const updatedTicket = await Ticket.findByPk(ticket.id, {
        include: [{ model: Tag, as: "tags" }]
      });
      if (updatedTicket) {
        getIO().to(`company-${ticket.companyId}-ticket`).emit("update", { ticket: updatedTicket });
      }
    }
  }

  // 3. Adicionar observação automaticamente
  if (aiActions?.note && aiActions.note.trim().length > 0) {
    await TicketNote.create({
      note: aiActions.note.trim(),
      ticketId: ticket.id,
      contactId: contact.id,
      userId: null
    });
  }

  // 4. Transferência automática para usuário
  if (aiActions?.user) {
    const userName = aiActions.user.trim();
    if (userName) {
      const user = await User.findOne({
        where: { name: userName, companyId: ticket.companyId }
      });
      if (user && user.id !== ticket.userId) {
        ticket.userId = user.id;
        await ticket.save();
        getIO().to(`company-${ticket.companyId}-ticket`).emit("update", { ticket });
      }
    }
  }
};

export const handleOpenAiLocal = async (

  openAiSettings: IOpenAi,
  msg: proto.IWebMessageInfo,
  wbot: Session,
  ticket: Ticket,
  contact: Contact,
  mediaSent: Message | undefined,
  ticketTraking: TicketTraking,
  groupedText?: string
): Promise<void> => {
  console.log("handleOpenAiLocal - INICIO");

  if (contact.disableBot) {
    console.log("handleOpenAiLocal - contato com bot desabilitado");
    return;
  }

  const bodyMessage = getBodyMessage(msg);
  if (!bodyMessage) {
    console.log("handleOpenAiLocal - bodyMessage vazio");
    return;
  }

  if (!openAiSettings) {
    console.log("handleOpenAiLocal - openAiSettings vazio");
    return;
  }
  if (msg.messageStubType) {
    console.log("handleOpenAiLocal - messageStubType presente");
    return;
  }

  let promptFinal = openAiSettings.prompt;
  try {
    const promptDb = await Prompt.findOne({ where: { name: openAiSettings.name } });
    if (promptDb) {
      promptFinal = promptDb.prompt;
    }
  } catch (e) {
    console.log("handleOpenAiLocal - erro ao buscar promptDb:", e);
  }

  // Busca filas, tags e usuários uma única vez
  const [allQueues, allTags, allUsers] = await Promise.all([
    Queue.findAll({ where: { companyId: ticket.companyId } }),
    Tag.findAll({ where: { companyId: ticket.companyId } }),
    User.findAll({ where: { companyId: ticket.companyId } })
  ]);
  const availableQueues = allQueues.map(queue => queue.name);
  const availableTags = allTags.map(tag => tag.name);
  const availableUsers = allUsers.map(user => user.name);

  // Adiciona log das filas, tags e usuários disponíveis
  console.log("Filas disponíveis para IA:", availableQueues);
  console.log("Tags disponíveis para IA:", availableTags);
  console.log("Usuários disponíveis para IA:", availableUsers);

  // --- Mova esta parte para cima ---
  const messages = await Message.findAll({
    where: { ticketId: ticket.id },
    order: [["createdAt", "ASC"]],
    limit: openAiSettings.maxMessages
  });

  const isSecondClientMessage = messages.filter(m => !m.fromMe).length >= 2;
  const isNearMaxMessages = isSecondClientMessage || messages.length >= openAiSettings.maxMessages - 1;


  // Ajuste o promptSystem para forçar decisão se estiver no limite:
  const promptSystem = `
Responda sempre de forma educada, personalizada e OBJETIVA, usando o nome ${sanitizeName(contact.name || "Amigo(a)")}.

IMPORTANTE: Antes de indicar fila, tag ou usuário, faça perguntas para entender claramente o problema ou a necessidade do cliente.
Somente utilize as funções (tools) para transferir fila, adicionar tag ou transferir usuário quando tiver informações suficientes para uma decisão adequada.
Nunca transfira ou categorize sem contexto suficiente. Se ainda não entendeu o pedido, faça perguntas para obter mais detalhes.
Se já estiver claro o motivo do contato, aí sim utilize as funções (tools) para indicar fila, tag e usuário.
Nunca apenas escreva a sugestão, sempre chame a função correspondente.
Seja breve e vá direto ao ponto, sem detalhar demais.

Filas disponíveis: ${JSON.stringify(availableQueues)}
Tags disponíveis: ${JSON.stringify(availableTags)}
Usuários disponíveis: ${JSON.stringify(availableUsers)}

Regras:
- Antes de transferir, certifique-se de entender o problema do cliente.
- Se não houver contexto suficiente, faça perguntas para obter mais informações.
- Só utilize as funções (tools) quando tiver certeza da necessidade do cliente.
- Utilize exatamente os nomes das filas, tags e usuários conforme listado acima.
- NUNCA mostre ao cliente que está executando uma ação automática ou que está escolhendo fila/tag/usuário.
${isNearMaxMessages ? `
ATENÇÃO: Você está no limite de mensagens permitido para análise. Agora, OBRIGATORIAMENTE, analise todo o histórico da conversa e utilize as funções (tools) para tomar a decisão mais adequada, mesmo que o contexto não esteja 100% claro. NÃO peça mais informações, apenas execute a automação necessária com base no que foi conversado até aqui. Você DEVE obrigatoriamente acionar pelo menos uma das funções (tools) disponíveis (transfer_queue, add_tag, transfer_user) de acordo com o contexto apresentado, mesmo que precise assumir a melhor opção possível.
` : ""}

${promptFinal}
`;
  const publicFolder: string = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "public",
    `company${ticket.companyId}`
  );

  let openai: OpenAI & { id?: number };
  const openAiIndex = sessionsOpenAi.findIndex(s => s.id === ticket.id);

  if (openAiIndex === -1) {
    openai = new OpenAI({
      apiKey: openAiSettings.apiKey
    }) as OpenAI & { id?: number };
    openai.id = ticket.id;
    sessionsOpenAi.push(openai);
  } else {
    openai = sessionsOpenAi[openAiIndex];
  }

  let messagesOpenAi = [];
  let transferredQueue: Queue | null = null;
  let transferredTag: Tag | null = null;
  let transferredUser: User | null = null;
  let noteToAdd: string | null = null;

  // --- Texto comum ---
  if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
    messagesOpenAi = [];
    messagesOpenAi.push({ role: "system", content: promptSystem });
    for (
      let i = 0;
      i < Math.min(openAiSettings.maxMessages, messages.length);
      i++
    ) {
      const message = messages[i];
      if (
        message.mediaType === "conversation" ||
        message.mediaType === "extendedTextMessage"
      ) {
        if (message.fromMe) {
          messagesOpenAi.push({ role: "assistant", content: message.body });
        } else {
          messagesOpenAi.push({ role: "user", content: message.body });
        }
      }
    }
    messagesOpenAi.push({ role: "user", content: bodyMessage! });

    // 1. Primeira chamada ao modelo
    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messagesOpenAi,
      tools,
      tool_choice: "auto",
      max_tokens: openAiSettings.maxTokens,
      temperature: openAiSettings.temperature
    });

    // 2. Executa as funções das tool_calls e adiciona ao histórico
    const toolCalls = chat.choices[0].message?.tool_calls || [];
    console.log("toolCalls:", JSON.stringify(toolCalls, null, 2));
    for (const call of toolCalls) {
      if (call.type === "function") {
        const args = JSON.parse(call.function.arguments);
        let result: any = null;
        if (call.function.name === "transfer_queue" && args.queue) {
          const queue = allQueues.find(q => q.name === args.queue);
          if (queue && queue.id !== ticket.queueId) {
            await transferQueue(queue.id, ticket, contact);
            transferredQueue = queue; // <-- ADICIONE ESTA LINHA!
            result = { success: true, queue: queue.name };
            console.log("Transferência realizada para:", queue.name);
          } else {
            result = { success: false, reason: "Fila não encontrada ou já atribuída" };
            console.log("Transferência NÃO realizada:", args.queue, queue?.id, ticket.queueId);
          }
        }
        if (call.function.name === "add_tag") {
          const tagNames = (args.tags || []).filter((tag: string) => availableTags.includes(tag));
          if (tagNames.length > 0) {
            const tags = await Tag.findAll({
              where: { name: tagNames, companyId: ticket.companyId }
            });
            for (const tag of tags) {
              await TicketTag.findOrCreate({
                where: { ticketId: ticket.id, tagId: tag.id }
              });
              await ContactTag.findOrCreate({
                where: { contactId: contact.id, tagId: tag.id }
              });
            }
          }
          if (args.note && typeof args.note === "string" && args.note.trim().length > 0) {
            await TicketNote.create({
              note: args.note.trim(),
              ticketId: ticket.id,
              contactId: contact.id,
              userId: null
            });
          }
          result = { success: true, tags: tagNames, note: args.note || null };
        }
        if (call.function.name === "transfer_user" && args.user) {
          const user = allUsers.find(u => u.name === args.user);
          if (user && user.id !== ticket.userId) {
            ticket.userId = user.id;
            await ticket.save();
            result = { success: true, user: user.name };
          } else {
            result = { success: false, reason: "Usuário não encontrado ou já atribuído" };
          }
        }
        // Adiciona mensagem de função ao histórico
        messagesOpenAi.push({
          role: "function",
          name: call.function.name,
          content: JSON.stringify(result)
        });
      }
    }

    // 3. Se houve function_call, faz nova chamada ao modelo com histórico atualizado
    let response = chat.choices[0].message?.content || "";
    if (toolCalls.length > 0) {
      const chat2 = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messagesOpenAi,
        tools,
        tool_choice: "auto",
        max_tokens: openAiSettings.maxTokens,
        temperature: openAiSettings.temperature
      });
      response = chat2.choices[0].message?.content || "";
    }

    // Filtra termos técnicos da resposta
    response = response.replace(/setor:\s*".*?"\s*/gi, "");
    response = response.replace(/especialista:\s*".*?"\s*/gi, "");
    response = response.replace(/tag:\s*".*?"\s*/gi, "");
    response = response.replace(/tags?:\s*".*?"\s*/gi, "");
    response = response.replace(/tags?:\s*\[.*?\]\s*/gi, "");
    response = response.replace(/^[\s\-:]*".*?"[\s\-:]*$/gim, "");
    response = response.replace(/(\r?\n){2,}/g, "\n\n");
    response = response.trim();

    if (response.length > 0) {
      if (openAiSettings.voice === "texto") {
        const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
          text: `\u200e ${response!}`
        });
        await verifyMessage(sentMessage!, ticket, contact);

        // Agora envie o greetingMessage da fila, se houver, APÓS a resposta do modelo:
        if (transferredQueue && transferredQueue.greetingMessage && transferredQueue.greetingMessage.trim() !== "") {
          await wbot.sendMessage(msg.key.remoteJid!, {
            text: `\u200e ${transferredQueue.greetingMessage}`
          });
        }
      } else {
        const fileNameWithOutExtension = `${ticket.id}_${Date.now()}`;
        convertTextToSpeechAndSaveToFile(
          keepOnlySpecifiedChars(response!),
          `${publicFolder}/${fileNameWithOutExtension}`,
          openAiSettings.voiceKey,
          openAiSettings.voiceRegion,
          openAiSettings.voice,
          "mp3"
        ).then(async () => {
          try {
            const sendMessage = await wbot.sendMessage(msg.key.remoteJid!, {
              audio: { url: `${publicFolder}/${fileNameWithOutExtension}.mp3` },
              mimetype: "audio/mpeg",
              ptt: true
            });
            await verifyMediaMessage(
              sendMessage!,
              ticket,
              contact,
              ticketTraking,
              false,
              false,
              wbot
            );
            deleteFileSync(`${publicFolder}/${fileNameWithOutExtension}.mp3`);
            deleteFileSync(`${publicFolder}/${fileNameWithOutExtension}.wav`);
          } catch (error) {
            console.log(`Erro para responder com audio: ${error}`);
          }
        });
      }
    }
  }
  // --- Fim do texto comum ---

  // --- Áudio (Whisper) ---
  else if (msg.message?.audioMessage) {
    const mediaUrl = mediaSent!.mediaUrl!.split("/").pop();
    const file = fs.createReadStream(`${publicFolder}/${mediaUrl}`) as any;

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: file
    });

    messagesOpenAi = [];
    messagesOpenAi.push({ role: "system", content: promptSystem });
    for (
      let i = 0;
      i < Math.min(openAiSettings.maxMessages, messages.length);
      i++
    ) {
      const message = messages[i];
      if (
        message.mediaType === "conversation" ||
        message.mediaType === "extendedTextMessage"
      ) {
        if (message.fromMe) {
          messagesOpenAi.push({ role: "assistant", content: message.body });
        } else {
          messagesOpenAi.push({ role: "user", content: message.body });
        }
      }
    }
    messagesOpenAi.push({ role: "user", content: transcription.text });

    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messagesOpenAi,
      tools,
      tool_choice: "auto",
      max_tokens: openAiSettings.maxTokens,
      temperature: openAiSettings.temperature
    });

    // --- WORKFLOW: Fila > Tag > Usuário > Observação ---
    let filaIdentificada = false;
    let tagsIdentificadas = false;
    let userIdentificado = false;
    let queue: Queue | null = null;
    let tagNames: string[] = [];
    let user: User | null = null;
    let noteToAdd: string | null = null;

    const toolCalls = chat.choices[0].message?.tool_calls || [];
    for (const call of toolCalls) {
      if (call.type === "function") {
        const args = JSON.parse(call.function.arguments);
        if (call.function.name === "transfer_queue" && args.queue) {
          const queue = allQueues.find(q => q.name === args.queue);
          if (queue && queue.id !== ticket.queueId) {
            await transferQueue(queue.id, ticket, contact);
            transferredQueue = queue;
            filaIdentificada = true;
          }
        }
      }
    }
    if (!filaIdentificada) {
      const responseText = chat.choices[0].message?.content || "";
      const filaMatch = responseText.match(/Fila:\s*([^\n]+)/i);
      if (filaMatch) {
        const queueName = filaMatch[1].trim();
        queue = allQueues.find(q => q.name.toLowerCase() === queueName.toLowerCase());
        if (queue && queue.id !== ticket.queueId) {
          await transferQueue(queue.id, ticket, contact);
          transferredQueue = queue;
          filaIdentificada = true;
        }
      }
    }

    for (const call of toolCalls) {
      if (call.type === "function" && call.function.name === "add_tag") {
        const args = JSON.parse(call.function.arguments);
        tagNames = (args.tags || []).filter((tag: string) => availableTags.includes(tag));
        if (tagNames.length > 0) {
          const tags = await Tag.findAll({
            where: { name: tagNames, companyId: ticket.companyId }
          });
          for (const tag of tags) {
            await TicketTag.findOrCreate({
              where: { ticketId: ticket.id, tagId: tag.id }
            });
            transferredTag = tag;
          }
          tagsIdentificadas = true;
        }
        // Captura a observação para adicionar depois do fluxo
        if (args.note && typeof args.note === "string" && args.note.trim().length > 0) {
          noteToAdd = args.note.trim();
        }
      }
    }
    if (!tagsIdentificadas) {
      const responseText = chat.choices[0].message?.content || "";
      const tagMatch = responseText.match(/Tag[s]?:\s*([^\n]+)/i);
      if (tagMatch) {
        tagNames = tagMatch[1].split(",").map(t => t.trim()).filter((tag: string) => availableTags.includes(tag));
        if (tagNames.length > 0) {
          const tags = await Tag.findAll({
            where: { name: tagNames, companyId: ticket.companyId }
          });
          for (const tag of tags) {
            await TicketTag.findOrCreate({
              where: { ticketId: ticket.id, tagId: tag.id }
            });
            transferredTag = tag;
          }
          tagsIdentificadas = true;
        }
      }
      // Observação via regex (opcional)
      const noteMatch = responseText.match(/Observa[cç][aã]o:\s*([^\n]+)/i);
      if (noteMatch) {
        noteToAdd = noteMatch[1].trim();
      }
    }

    for (const call of toolCalls) {
      if (call.type === "function" && call.function.name === "transfer_user") {
        const args = JSON.parse(call.function.arguments);
        user = allUsers.find(u => u.name === args.user);
        if (user && user.id !== ticket.userId) {
          ticket.userId = user.id;
          await ticket.save();
          transferredUser = user;
          userIdentificado = true;
        }
      }
    }
    if (!userIdentificado) {
      const responseText = chat.choices[0].message?.content || "";
      const userMatch = responseText.match(/Usu[aá]rio:\s*([^\n]+)/i);
      if (userMatch) {
        const userName = userMatch[1].trim();
        user = allUsers.find(u => u.name.toLowerCase() === userName.toLowerCase());
        if (user && user.id !== ticket.userId) {
          ticket.userId = user.id;
          await ticket.save();
          transferredUser = user;
          userIdentificado = true;
        }
      }
    }

    // 4. Observação (após todo o fluxo)
    if (noteToAdd && noteToAdd.length > 0) {
      await TicketNote.create({
        note: noteToAdd,
        ticketId: ticket.id,
        contactId: contact.id,
        userId: null
      });
    }

    let response = chat.choices[0].message?.content || "";

    if (transferredQueue && transferredQueue.greetingMessage && transferredQueue.greetingMessage.trim() !== "") {
      await wbot.sendMessage(msg.key.remoteJid!, {
        text: `\u200e ${transferredQueue.greetingMessage}`
      });
    }

    response = response.replace(/setor:\s*".*?"\s*/gi, "");
    response = response.replace(/especialista:\s*".*?"\s*/gi, "");
    response = response.replace(/tag:\s*".*?"\s*/gi, "");
    response = response.replace(/tags?:\s*".*?"\s*/gi, "");
    response = response.replace(/tags?:\s*\[.*?\]\s*/gi, "");
    response = response.replace(/^[\s\-:]*".*?"[\s\-:]*$/gim, "");
    response = response.replace(/(\r?\n){2,}/g, "\n\n");
    response = response.trim();

    if (openAiSettings.voice === "texto") {
      const sentMessage = await wbot.sendMessage(msg.key.remoteJid!, {
        text: `\u200e ${response!}`
      });
      await verifyMessage(sentMessage!, ticket, contact);
    } else {
      const fileNameWithOutExtension = `${ticket.id}_${Date.now()}`;
      convertTextToSpeechAndSaveToFile(
        keepOnlySpecifiedChars(response!),
        `${publicFolder}/${fileNameWithOutExtension}`,
        openAiSettings.voiceKey,
        openAiSettings.voiceRegion,
        openAiSettings.voice,
        "mp3"
      ).then(async () => {
        try {
          const sendMessage = await wbot.sendMessage(msg.key.remoteJid!, {
            audio: { url: `${publicFolder}/${fileNameWithOutExtension}.mp3` },
            mimetype: "audio/mpeg",
            ptt: true
          });
          await verifyMediaMessage(
            sendMessage!,
            ticket,
            contact,
            ticketTraking,
            false,
            false,
            wbot
          );
          deleteFileSync(`${publicFolder}/${fileNameWithOutExtension}.mp3`);
          deleteFileSync(`${publicFolder}/${fileNameWithOutExtension}.wav`);
        } catch (error) {
          console.log(`Erro para responder com audio: ${error}`);
        }
      });
    }
  }

  messagesOpenAi = [];
  console.log("handleOpenAiLocal - FIM");
};

export const handleOpenAi = handleOpenAiLocal;