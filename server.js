const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.5-flash"; 

app.post('/webhook', async (req, res) => {
    // 1. Phản hồi lập tức HTTP 200 OK giải phóng giao diện cho AppSheet
    res.status(200).json({ status: "Received" });

    // 2. Tiếp nhận Payload dữ liệu từ AppSheet Webhook gửi sang
    const { ID, BookingInfo, StudentAnswer } = req.body;

    console.log(`\n=== [CHẶNG 1] TIẾN TRÌNH XỬ LÝ PHÁT HÀNH BOOKING NOTE - ID: ${ID} ===`);

    // 3. KÍCH HOẠT TIẾN TRÌNH WORKER CHẠY NGẦM BẤT ĐỒNG BỘ (ASYNC WORKER)
    processCarrierBookingWorkflow(ID, BookingInfo, StudentAnswer);
});

async function processCarrierBookingWorkflow(id, bookingInfo, studentAnswer) {
    try {
        const today = new Date();
        const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // PROMPT THIẾT KẾ ĐẶC BIỆT: Bắt lỗi ngôn ngữ và khóa chặn giới hạn 2 cảng Cát Lái / Hải Phòng
        const prompt = `
You are the automated Booking Desk Desk of a global Container Shipping Line (Carrier). Your job is to audit the [STUDENT BOOKING REQUEST] against the [PRICING & DEPOT MATRIX], calculate freight rates, map depot locations, and compute scheduling deadlines.

CRITICAL WORKFLOW RULES:

1. LANGUAGE ENFORCEMENT:
   - Scan [STUDENT BOOKING REQUEST] for ANY Vietnamese words or accents (e.g., "tôi", "muốn", "ngày", "cảng", "vui lòng", etc.).
   - If ANY Vietnamese text is found, instantly set "is_vietnamese" to true.

2. PORT OF LOADING (POL) VALIDATION (STRICT ROUTING FILTER):
   - If "is_vietnamese" is false, extract the Port of Loading (POL) requested by the student.
   - The allowed ports are ONLY "Cat Lai" (or Ho Chi Minh/Cat Lai) and "Hai Phong".
   - If the student requests ANY other port as POL (e.g., Da Nang, Qui Nhon, Vung Tau, etc.), you MUST instantly set "is_invalid_port" to true.
   - If "is_invalid_port" is true, the "booking_note" field MUST be an empty string "".

3. DEFAULT BILL TYPE COMPLIANCE:
   - If the student DOES NOT explicitly specify the bill release type (e.g., Surrendered, Telex Release) in their request, default the status to "Original Bill" and evaluate the Telex fee as 0 USD.

4. DYNAMIC SCHEDULE & DEADLINE CALCULATIONS:
   - Based on the requested ETD, calculate operational timelines relative to that specific date:
     * Empty Pick-up Date = ETD minus 5 days (Format: DD/MM/YYYY)
     * Shipping Instruction Cut-off (SI Cut-off) = ETD minus 3 days at 10:00 AM (Format: DD/MM/YYYY)
     * Verified Gross Mass Cut-off (VGM Cut-off) = ETD minus 2 days at 14:00 PM (Format: DD/MM/YYYY)
     * Closing Time / CY Cut-off = ETD minus 1 day at 17:00 PM (Format: DD/MM/YYYY)
     * Estimated Time of Arrival (ETA) = ETD plus 14 days (Format: DD/MM/YYYY)

5. TARIFF & DEPOT ALLOCATION:
   - Read the [PRICING & DEPOT MATRIX] to calculate dynamic cước biển (Ocean Freight) based on requested POD, size modifier, and time surcharges (+10% or -10%) relative to the [SYSTEM CURRENT DATE].
   - Extract the specific Empty Pick-up Depot and Full Return CY locations corresponding to the student's selected valid port (Cat Lai or Hai Phong).

[PRICING & DEPOT MATRIX (Thông tin booking)]:
${bookingInfo}

[SYSTEM CURRENT DATE]: ${formattedDate}

[STUDENT BOOKING REQUEST (Câu trả lời_user)]:
${studentAnswer || ""}

---
YOU MUST RESPOND ONLY WITH A RAW JSON OBJECT. DO NOT WRAP IN MARKDOWN CODE BLOCKS.
Required JSON Schema:
{
  "is_vietnamese": true/false,
  "is_invalid_port": true/false,
  "booking_note": "The full 100% English Booking Confirmation document text containing the computed prices, time deadlines (SI/VGM Cut-off, Closing time, ETD, ETA), and allocated Depot Locations. Leave as empty string '' if is_vietnamese is true or is_invalid_port is true."
}

[VĂN BẢN ĐẦU RA MẪU CHO FIELD BOOKING_NOTE]:
=== BOOKING CONFIRMATION / NOTICE ===
Booking No: BKG${id}XNK
Status: CONFIRMED
Bill Type Default: [Insert calculated Bill type]

[ROUTING INFORMATION]
- Port of Loading (POL): [Insert extracted POL]
- Port of Discharge (POD): [Insert extracted POD]
- Intended Vessel/Voyage: PACIFIC EXPRESS V.2026N

[EQUIPMENT & COMMODITY]
- Container Type / Qty: [Insert size and qty]
- Commodity: General Cargo / Training Materials

[CRITICAL DEADLINES & TIME MATRIX]
- Empty Pick-up Date: [Insert calculated date]
- SI Cut-off Time: [Insert calculated date] 10:00 AM
- VGM Cut-off Time: [Insert calculated date] 14:00 PM
- CY Cut-off / Closing Time: [Insert calculated date] 17:00 PM
- Estimated Time of Departure (ETD): [Insert Student's requested ETD]
- Estimated Time of Arrival (ETA): [Insert calculated date]

[DYNAMIC FREIGHT & LOCAL CHARGES SUMMARY]
- Ocean Freight (O/F): [Show Base rate + Surcharge] -> Final O/F: [Insert amount] USD
- Terminal Handling Charge (THC): [Insert amount] USD
- Documentation Fee: [Insert amount] USD
- Seal Fee: [Insert amount] USD
- LSS Surcharge: [Insert amount] USD
- Destination Manifest Surcharge (ENS/AMS): [Insert amount] USD
--------------------------------------------------
TOTAL FREIGHT & LOCAL CHARGES: [Insert sum] USD

[DEPOT INSTRUCTIONS]
- Empty Pick-up Location: [Insert matching Depot from Matrix]
- Full Return Location (CY): [Insert matching CY from Matrix]

=== POTENTIAL PENALTY & CONTINGENCY TARIFF NOTICE ===
(Disclosed for compliance. These fees are currently $0 USD but will activate if violated)
- Late SI/VGM Submission: 50 USD / Bill (If submitted after Closing Time)
- Bill of Lading Amendment: 40 USD / Bill (If requested after Draft Deadline)
- Container Rollover Fee: 100 USD / Container (If Customs Clearance fails at CY Cut-off)
- Demurrage (DEM Rate): 40 USD / Day (After 5 Days free-time at Port)
- Detention (DET Rate): 30 USD / Day (After 3 Days free-time at Warehouse)
`;

        // Khởi tạo AI với cấu hình ép kiểu Schema JSON
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });

        const result = await model.generateContent(prompt);
        const aiResult = JSON.parse(result.response.text());

        let targetBookingNote = "";
        let targetStateManagement = "";

        // BỘ ĐIỀU HƯỚNG LOGIC THEO YÊU CẦU MỚI
        if (aiResult.is_vietnamese === true) {
            console.log(`>>> [Lỗi Ngôn Ngữ] ID ${id}: Chứa tiếng Việt.`);
            targetBookingNote = ""; 
            targetStateManagement = "Yêu cầu viết lại (Sai ngôn ngữ)";
        } 
        else if (aiResult.is_invalid_port === true) {
            console.log(`>>> [Lỗi Tuyến Đường] ID ${id}: POL ngoài hệ thống.`);
            targetBookingNote = ""; 
            // Trả về câu từ chối tiếng Anh chuyên ngành theo đúng yêu cầu của bạn
            targetStateManagement = "No space available for this routing. Please verify your port of loading and select another port.";
        } 
        else {
            console.log(`>>> [Cấp Thành Công] ID ${id}: Phát hành Booking Note.`);
            targetBookingNote = aiResult.booking_note;
            targetStateManagement = ""; // Xóa thông báo lỗi cũ
        }

        // Thực thi cập nhật dữ liệu về AppSheet Database
        await updateAppSheetDatabase(id, targetBookingNote, targetStateManagement);

    } catch (error) {
        console.error(`!!! Thất bại chặng 1 bản ghi ID ${id}:`, error.message);
    }
}

async function updateAppSheetDatabase(id, bookingNoteContent, stateStatus) {
    const tableName = encodeURIComponent("thực hành_user_module"); 
    const url = `https://api.appsheet.com/api/v2/apps/${process.env.APPSHEET_APP_ID}/tables/${tableName}/Action`;

    const body = {
        "Action": "Edit",
        "Properties": { "Locale": "vi-VN", "Timezone": "SE Asia Standard Time" },
        "Rows": [{ 
            "ID": id, 
            "AI_tạo lập": bookingNoteContent, 
            "State Management_booking": stateStatus
        }]
    };

    try {
        await axios.post(url, body, {
            headers: { 'ApplicationAccessKey': process.env.APPSHEET_ACCESS_KEY, 'Content-Type': 'application/json' }
        });
        console.log(`[Database Synced] ID: ${id}`);
    } catch (err) {
        console.error("!!! Lỗi đường truyền REST API:", err.message);
    }
}

app.listen(PORT, () => { console.log(`🚀 [Carrier Booking Desk Chặng 1] hoạt động tại Port: ${PORT}`); });
