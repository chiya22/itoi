const nodemailer = require('nodemailer');

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

/**
 * メール送信を行う
 * 
 * @param {*} title メールタイトル
 * @param {*} content メール本文
 */
const sendMail = (title, content) => {

  // ▼XServer送信用
  const smtpConfig = {
    host: process.env.XSERVER_HOST_NAME,
    port: '465',
    secure: true,
    auth: {
        user: process.env.XSERVER_USER_NAME,
        pass: process.env.XSERVER_PASSWORD,
    }
  };

  const transporter = nodemailer.createTransport(smtpConfig);

  // メール情報
  const message = {
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject: title,
    text: content,
  };
  return transporter.sendMail(message);
};

module.exports = {
  sendMail
};
