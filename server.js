// server.js

// Importations nécessaires
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require("mongodb");
const crypto = require("crypto");

// Configuration du serveur Express
const app = express();

// Middleware pour CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // Remplacez '*' par l'URL de votre frontend en production
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// Middleware bodyParser pour parser les données JSON
app.use(bodyParser.json());

// Configuration des clés API et autres informations sensibles
const PLISIO_API_KEY = process.env.PLISIO_API_KEY;
const PLISIO_SECRET_KEY = process.env.PLISIO_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const BACKEND_URL = process.env.BACKEND_URL;
const PORT = process.env.PORT;

function verifyCallbackData(data) {
  if (typeof data === "object" && data.verify_hash && PLISIO_SECRET_KEY) {
    // Trier les clés alphabétiquement
    const ordered = Object.keys(data)
      .sort()
      .reduce((obj, key) => {
        if (key !== "verify_hash") {
          // S'assurer que verify_hash est exclu
          obj[key] = data[key];
        }
        return obj;
      }, {});
    const string = JSON.stringify(ordered);
    const hmac = crypto.createHmac("sha1", PLISIO_SECRET_KEY);
    hmac.update(string);
    const hash = hmac.digest("hex");

    return hash === data.verify_hash;
  }
  return false;
}

// Montants de base pour les abonnements
const baseAmounts = {
  "1_month": 19.99,
  "3_months": 49.99,
  "6_months": 79.99,
  "12_months": 139.99,
};

// Classe DatabaseManager pour gérer la base de données
class DatabaseManager {
  constructor() {
    const uri = MONGODB_URI;
    this.client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    this.dbName = "ssp";
    this.isConnected = false;
  }

  async connect() {
    if (!this.isConnected) {
      try {
        await this.client.connect();
        this.isConnected = true;
        console.log("Connecté à MongoDB");
      } catch (error) {
        console.error("Échec de la connexion à MongoDB", error);
        throw error;
      }
    }
    this.db = this.client.db(this.dbName);
    this.users = this.db.collection("users");
    this.invoices = this.db.collection("invoices");
    this.promos = this.db.collection("promos");
  }

  async addUser(
    stakeUsername,
    subscriptionType,
    subscriptionStart,
    subscriptionEnd
  ) {
    await this.connect();
    const result = await this.users.insertOne({
      stake_username: stakeUsername,
      subscription_type: subscriptionType,
      subscription_start: new Date(subscriptionStart),
      subscription_end: new Date(subscriptionEnd),
    });
    return result.insertedId;
  }

  async getUser(stakeUsername) {
    await this.connect();
    return await this.users.findOne({
      stake_username: { $regex: new RegExp(`^${stakeUsername}$`, "i") },
    });
  }

  async updateUserSubscription(
    stakeUsername,
    subscriptionType,
    subscriptionEnd
  ) {
    await this.connect();
    const result = await this.users.updateOne(
      { stake_username: { $regex: new RegExp(`^${stakeUsername}$`, "i") } },
      {
        $set: {
          subscription_type: subscriptionType,
          subscription_end: new Date(subscriptionEnd),
        },
      }
    );
    return result.modifiedCount;
  }

  async createInvoice(
    txnId,
    orderNumber,
    stakeUsername,
    subscriptionType,
    amount,
    currency,
    status,
    promoCode
  ) {
    await this.connect();
    const result = await this.invoices.insertOne({
      txn_id: txnId,
      order_number: orderNumber,
      stake_username: stakeUsername,
      subscription_type: subscriptionType,
      amount: amount,
      currency: currency,
      status: status,
      promoCode: promoCode,
      created_at: new Date(),
    });
    return result.insertedId;
  }

  async updateInvoiceStatus(orderNumber, status, txnId) {
    await this.connect();
    const result = await this.invoices.updateOne(
      { order_number: orderNumber },
      {
        $set: {
          status: status,
          txn_id: txnId,
          updated_at: new Date(),
        },
      }
    );
    return result.modifiedCount;
  }

  async getInvoice(orderNumber) {
    await this.connect();
    const invoice = await this.invoices.findOne({ order_number: orderNumber });
    return invoice;
  }

  async verifyPromoCode(promoCode, subscriptionType) {
    await this.connect();
    const promo = await this.promos.findOne({ code: promoCode });

    if (!promo) {
      return { isValid: false, message: "Code promo invalide." };
    }

    const now = new Date();
    if (now > promo.expirationDate) {
      return { isValid: false, message: "Ce code promo a expiré." };
    }

    if (promo.usageLimit <= 0) {
      return {
        isValid: false,
        message: "Ce code promo a atteint sa limite d'utilisation.",
      };
    }

    // Vérifier si le code promo s'applique au type d'abonnement sélectionné
    if (!promo.applicableDurations.includes(subscriptionType)) {
      return {
        isValid: false,
        message:
          "Ce code promo n'est pas applicable pour la durée d'abonnement sélectionnée.",
      };
    }

    return { isValid: true, discount: promo.discount };
  }

  async usePromoCode(promoCode) {
    await this.connect();
    const result = await this.promos.updateOne(
      { code: promoCode },
      { $inc: { usageLimit: -1 } }
    );
    return result.modifiedCount === 1;
  }

  async revertPromoCode(promoCode) {
    await this.connect();
    const result = await this.promos.updateOne(
      { code: promoCode },
      { $inc: { usageLimit: 1 } }
    );
    return result.modifiedCount === 1;
  }

  async close() {
    if (this.isConnected) {
      await this.client.close();
      this.isConnected = false;
    }
  }
}

// Instancier le DatabaseManager
const Database = new DatabaseManager();

// Fonction pour calculer la date de fin d'abonnement
function calculateSubscriptionEnd(subscriptionType) {
  const now = new Date();
  switch (subscriptionType) {
    case "1_month":
      return new Date(now.setMonth(now.getMonth() + 1));
    case "3_months":
      return new Date(now.setMonth(now.getMonth() + 3));
    case "6_months":
      return new Date(now.setMonth(now.getMonth() + 6));
    case "12_months":
      return new Date(now.setFullYear(now.getFullYear() + 1));
    default:
      throw new Error("Type d'abonnement invalide");
  }
}

// Endpoint pour vérifier l'utilisateur
app.post("/verify-user", async (req, res) => {
  const { stakeUsername } = req.body;

  try {
    const user = await Database.getUser(stakeUsername);

    if (user) {
      const now = new Date();
      const subscriptionEnd = new Date(user.subscription_end);

      if (now <= subscriptionEnd) {
        res.json({
          isValid: true,
          message: `Bienvenue, ${stakeUsername} ! Votre abonnement est valide jusqu'au ${subscriptionEnd.toLocaleDateString()}.`,
        });
      } else {
        res.json({
          isValid: false,
          message: `Votre abonnement a expiré le ${subscriptionEnd.toLocaleDateString()}. Veuillez le renouveler.`,
          needsRenewal: true,
        });
      }
    } else {
      res.json({
        isValid: false,
        message: `Bienvenue, ${stakeUsername} ! Veuillez vous abonner pour utiliser l'application.`,
        needsSubscription: true,
      });
    }
  } catch (error) {
    console.error("Erreur lors de la vérification de l'utilisateur :", error);
    res.status(500).json({ message: "Erreur interne du serveur." });
  }
});

// Endpoint pour appliquer un code promo
app.post("/apply-promo", async (req, res) => {
  const { promoCode, subscriptionType } = req.body;

  try {
    const promoResult = await Database.verifyPromoCode(
      promoCode,
      subscriptionType
    );
    if (promoResult.isValid) {
      const currentPrices = { ...baseAmounts };
      currentPrices[subscriptionType] *= 1 - promoResult.discount;

      res.json({
        success: true,
        updatedPrices: currentPrices,
        appliedTo: subscriptionType,
      });
    } else {
      res.json({ success: false, message: promoResult.message });
    }
  } catch (error) {
    console.error("Erreur lors de la vérification du code promo :", error);
    res.status(500).json({
      success: false,
      message: "Une erreur est survenue lors de la vérification du code promo.",
    });
  }
});

// Endpoint pour créer une invoice Plisio
app.post("/create-invoice", async (req, res) => {
  const { stakeUsername, subscriptionType, currency, promoCode } = req.body;

  try {
    let amount = baseAmounts[subscriptionType];

    if (promoCode) {
      const promoResult = await Database.verifyPromoCode(
        promoCode,
        subscriptionType
      );
      if (promoResult.isValid) {
        amount *= 1 - promoResult.discount;
        await Database.usePromoCode(promoCode);
      } else {
        return res.json({ success: false, message: promoResult.message });
      }
    }

    const orderNumber = `${stakeUsername}-${Date.now()}`;

    // URL de callback pour Plisio (doit être accessible publiquement)
    const callbackUrl = `https://${BACKEND_URL}/plisio-callback?json=true`;

    const response = await axios.get("https://plisio.net/api/v1/invoices/new", {
      params: {
        source_currency: "USD",
        source_amount: amount,
        currency: currency,
        order_number: orderNumber,
        order_name: `Subscription ${subscriptionType}`,
        email: "customer@example.com",
        callback_url: callbackUrl,
        api_key: PLISIO_API_KEY,
      },
    });

    if (response.data.status === "success") {
      const invoiceData = response.data.data;

      // Enregistrer l'invoice dans la base de données
      await Database.createInvoice(
        invoiceData.txn_id,
        orderNumber,
        stakeUsername,
        subscriptionType,
        invoiceData.invoice_total_sum,
        currency,
        "pending",
        promoCode
      );

      res.json({
        success: true,
        invoiceUrl: invoiceData.invoice_url,
      });
    } else {
      if (appliedPromo) {
        await Database.revertPromoCode(appliedPromo);
      }
      res.json({
        success: false,
        message: "Échec de la création de l'invoice Plisio.",
      });
    }
  } catch (error) {
    console.error("Erreur lors de la création de l'invoice :", error);
    if (promoCode) {
      await Database.revertPromoCode(promoCode);
    }
    res.status(500).json({ message: "Erreur interne du serveur." });
  }
});

// Endpoint pour le callback de Plisio (avec json=true)
app.post("/plisio-callback", async (req, res) => {
  const data = req.body;

  // Vérifier l'authenticité du callback
  if (!verifyCallbackData(data)) {
    console.error("Données de callback invalides");
    return res.status(422).send("Données de callback invalides");
  }

  const { txn_id, status, order_number } = data;

  try {
    // Mettre à jour le statut de l'invoice dans la base de données
    await Database.updateInvoiceStatus(order_number, status, txn_id);

    if (status === "completed") {
      const invoice = await Database.getInvoice(order_number);

      if (invoice) {
        const stakeUsername = invoice.stake_username;
        const subscriptionEnd = calculateSubscriptionEnd(
          invoice.subscription_type
        );

        const user = await Database.getUser(stakeUsername);

        if (user) {
          // Mettre à jour l'abonnement de l'utilisateur
          await Database.updateUserSubscription(
            stakeUsername,
            invoice.subscription_type,
            subscriptionEnd
          );
        } else {
          // Ajouter un nouvel utilisateur
          await Database.addUser(
            stakeUsername,
            invoice.subscription_type,
            new Date(),
            subscriptionEnd
          );
        }

        res.status(200).send("OK");
      } else {
        res.status(404).send("Invoice non trouvée");
      }
    } else if (status === "expired" || status === "cancelled") {
      // Remettre à jour le code promo si le paiement n'est pas complété
      const invoice = await Database.getInvoice(order_number);
      if (invoice && invoice.promoCode) {
        await Database.revertPromoCode(invoice.promoCode);
      }
      res.status(200).send(`Statut du paiement : ${status}`);
    } else {
      res.status(200).send(`Statut du paiement : ${status}`);
    }
  } catch (error) {
    console.error("Erreur lors du traitement du callback :", error);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Démarrage du serveur
app.listen(PORT, async () => {
  // Assurez-vous que la connexion à la base de données est établie
  try {
    await Database.connect();
    console.log(
      `Le serveur backend est en cours d'exécution sur le port ${PORT}`
    );
  } catch (error) {
    console.error("Erreur lors de la connexion à la base de données :", error);
  }
});
