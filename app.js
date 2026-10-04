/* =========================================================
   ORTAK DÜNYA VERİTABANI — SUPABASE
   Tüm kullanıcılar aynı çiftlik durumunu paylaşır.
========================================================= */
const SUPABASE_URL = "https://xzkizeuaruuyagxgtwry.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_tlTTHhoiUD5yXxbePgHScA_iA9I_6Nb";
let sharedBackend = { client:null, ready:false, syncing:false, applyingRemote:false, channel:null, version:0 };

function sharedGameSnapshot(){
    try{
        return JSON.parse(JSON.stringify(game));
    }catch(error){
        console.warn("Ortak dünya verisi hazırlanamadı:",error);
        return {};
    }
}

async function pushGameToSharedWorld(){
    if(!sharedBackend.ready || sharedBackend.syncing || sharedBackend.applyingRemote) return;
    sharedBackend.syncing=true;
    try{
        const {data:current,error:readError}=await sharedBackend.client
            .from("farm_world")
            .select("version")
            .eq("id",1)
            .maybeSingle();
        if(readError) throw readError;
        const nextVersion=Number(current?.version||0)+1;
        const snapshot=sharedGameSnapshot();
        const {data:updated,error}=await sharedBackend.client
            .from("farm_world")
            .update({
                state:snapshot,
                day:Number(game.day)||1,
                money:Number(game.money)||0,
                feed:Number(game.feed)||0,
                milk:Number(game.totalMilk)||0,
                version:nextVersion,
                updated_at:new Date().toISOString()
            })
            .eq("id",1)
            .eq("version",Number(current?.version||0))
            .select("version")
            .maybeSingle();
        if(error) throw error;
        if(updated){
            sharedBackend.version=nextVersion;
        }else{
            const {data:latest,error:latestError}=await sharedBackend.client
                .from("farm_world")
                .select("state,version")
                .eq("id",1)
                .single();
            if(!latestError && latest?.state && Object.keys(latest.state).length){
                applySharedGame(latest.state,Number(latest.version||0));
            }
        }
    }catch(error){
        console.warn("Ortak dünya kaydı başarısız:",error);
    }finally{
        sharedBackend.syncing=false;
    }
}

let sharedSaveTimer=null;
function queueSharedBackendSave(){
    if(!sharedBackend.ready) return;
    clearTimeout(sharedSaveTimer);
    sharedSaveTimer=setTimeout(()=>pushGameToSharedWorld(),180);
}

function applySharedGame(remoteState,remoteVersion=0){
    if(!remoteState || typeof remoteState!=="object" || !Object.keys(remoteState).length) return false;
    const incomingVersion=Number(remoteVersion||0);
    if(sharedBackend.ready && incomingVersion>0 && incomingVersion<Number(sharedBackend.version||0)) return false;
    try{
        sharedBackend.applyingRemote=true;
        if(incomingVersion>0) sharedBackend.version=incomingVersion;
        game=remoteState;
        try{ localStorage.setItem("ciftlikSimulasyonu",JSON.stringify(game)); }catch(e){}
        render();
        return true;
    }catch(error){
        console.warn("Ortak dünya verisi uygulanamadı:",error);
        return false;
    }finally{
        sharedBackend.applyingRemote=false;
    }
}

async function loadSharedAudioSettings(){
    if(!sharedBackend.client) return;
    try{
        const {data,error}=await sharedBackend.client
            .from("farm_settings")
            .select("sound_enabled,sound_url,sound_volume")
            .eq("id",1)
            .maybeSingle();
        if(error) throw error;
        if(data){
            FARM_AUDIO_CONFIG.enabled=data.sound_enabled!==false;
            FARM_AUDIO_CONFIG.url=data.sound_url||"sounds/nature.wav";
            FARM_AUDIO_CONFIG.volume=Math.max(0,Math.min(1,Number(data.sound_volume??0.45)));

            if(farmAudio){
                if(!FARM_AUDIO_CONFIG.enabled){
                    stopFarmAmbience();
                }else if(farmAudio.nature?.src !== new URL(FARM_AUDIO_CONFIG.url,document.baseURI).href){
                    stopFarmAmbience();
                    startFarmAmbience();
                }else{
                    farmAudio.masterVolume=FARM_AUDIO_CONFIG.volume;
                    resumeFarmAudio();
                }
            }
        }
    }catch(error){
        console.warn("Ortak ses ayarları alınamadı:",error);
    }
}

async function initSharedBackend(){
    if(sharedBackend.ready) return;
    try{
        if(!window.supabase || !window.supabase.createClient){
            console.warn("Supabase istemcisi yüklenmedi.");
            return;
        }
        sharedBackend.client=window.supabase.createClient(
            SUPABASE_URL,
            SUPABASE_PUBLISHABLE_KEY
        );

        const {data,error}=await sharedBackend.client
            .from("farm_world")
            .select("state,version")
            .eq("id",1)
            .maybeSingle();

        if(error) throw error;

        sharedBackend.ready=true;

        await loadSharedAudioSettings();

        sharedBackend.version=Number(data?.version||0);
        if(data?.state && Object.keys(data.state).length){
            applySharedGame(data.state,sharedBackend.version);
        }else{
            await pushGameToSharedWorld();
        }

        sharedBackend.client
            .channel("ciftlik-ses-ayarlari")
            .on(
                "postgres_changes",
                {event:"UPDATE",schema:"public",table:"farm_settings",filter:"id=eq.1"},
                payload=>{
                    const data=payload?.new;
                    if(!data) return;
                    FARM_AUDIO_CONFIG.enabled=data.sound_enabled!==false;
                    FARM_AUDIO_CONFIG.url=data.sound_url||"sounds/nature.wav";
                    FARM_AUDIO_CONFIG.volume=Math.max(0,Math.min(1,Number(data.sound_volume??0.45)));
                    if(!FARM_AUDIO_CONFIG.enabled){
                        stopFarmAmbience();
                    }else if(!farmAudio){
                        startFarmAmbience();
                    }else{
                        farmAudio.masterVolume=FARM_AUDIO_CONFIG.volume;
                        resumeFarmAudio();
                    }
                }
            )
            .subscribe();

        sharedBackend.channel=sharedBackend.client
            .channel("ciftlik-ortak-dunya")
            .on(
                "postgres_changes",
                {event:"UPDATE",schema:"public",table:"farm_world",filter:"id=eq.1"},
                payload=>{
                    const incoming=payload?.new?.state;
                    const incomingVersion=Number(payload?.new?.version||0);
                    if(incoming && Object.keys(incoming).length){
                        applySharedGame(incoming,incomingVersion);
                    }
                }
            )
            .subscribe();

        console.log("🌍 Ortak dünya bağlantısı aktif.");
    }catch(error){
        sharedBackend.ready=false;
        console.warn("🌍 Ortak dünya bağlantısı kurulamadı:",error);
    }
}

/* =========================================================
   ÇİFTLİK SİMÜLASYONU
   CORE ENGINE v1.2
========================================================= */


/* =========================================================
   SABİTLER
========================================================= */

/* =========================================================
   ORTAK DÜNYA SAATİ
   6 gerçek dakika = 1 oyun günü
   1 gerçek saniye = 4 oyun dakikası
   Saat cihazdan bağımsız olarak UTC tabanlı hesaplanır.
========================================================= */
const GAME_MINUTES_PER_REAL_SECOND = 4;
const GAME_MINUTES_PER_DAY = 1440;

/* Ortak dünya başlangıcı: 04.10.2026 00:00 UTC -> Oyun 1. Gün 06:00 */
const WORLD_CLOCK_EPOCH = Date.UTC(2026,9,3,21,0,0);
const WORLD_CLOCK_START_MINUTE = 360;

const FEED_PRICE = 19.07;

const MILK_PRICE = 24.30;

const SAVE_VERSION = 2;

const REPRODUCTION_CONFIG = {
    estrousCycleMin:17,
    estrousCycleMax:21,
    gestationDays:283,
    voluntaryWaitingDays:50,
    heatDurationDays:2,
    dryPeriodTargetDays:60
};
const STARTING_DONATION = 35000;
const STARTING_FEED_SUPPORT = 750;
const COW_PURCHASE_PRICE = 25000;

const INITIAL_MONEY = 0;

const INITIAL_FEED = 0;


/* =========================================================
   OYUN
========================================================= */

let game = {

    saveVersion:SAVE_VERSION,
    day:1,

    minute:360,

    money:INITIAL_MONEY,

    feed:INITIAL_FEED,

    totalMilk:0,

    todayMilk:0,

    rawMilkStock:0,
    rawMilkTankCapacity:2000,
    processingQueue:[],
    coldStorage:{pasteurizedMilk:0,yogurt:0,cheese:0},
    processedProducts:{pasteurizedMilk:0,yogurt:0,cheese:0},
    bank:{
        loans:[],
        grantApplications:[],
        totalBorrowed:0,
        totalRepaid:0,
        totalGrantIncome:0
    },

    veterinary:{
        invoices:[],
        totalInvoiced:0,
        totalPaid:0,
        maxOutstanding:20000
    },

    income:0,

    expenses:0,

    milkingStrategy:3,

    milkingWorker:{
        hired:false,
        name:"Sağım İşçisi",
        hireCost:2500,
        dailyWage:750,
        hiredDay:null
    },

    pendingMilkingStrategy:null,

    lastRealTime:Date.now(),

    lastMilking:"",
    lastMilkingSlot:"",
    lastAutomaticMilkingDay:0,
    lastAutomaticMilkingHour:-1,

    accountingLedger:[],

    messages:[],
    onboardingStep:0,

    dataSource:{
        milkPrice:"USK 2026: 24.30 TL/L",
        feedPrice:"USK 2026: latest published milk feed 19.07 TL/kg",
        updated:"2026-08"
    },

    cows:[],

    ration:{

        ingredients:{

            cornSilage:{
                name:"Mısır Silajı",
                dm:35,
                ndf:42,
                starch:30,
                cp:8,
                adf:25,
                ndfd:45,
                price:4.5
            },

            alfalfaHay:{
                name:"Yonca Kuru Otu",
                dm:90,
                ndf:40,
                starch:5,
                cp:18,
                adf:30,
                ndfd:50,
                price:9
            },

            cornGrain:{
                name:"Mısır Dane",
                dm:88,
                ndf:10,
                starch:72,
                cp:9,
                adf:3,
                ndfd:80,
                price:11
            },

            barley:{
                name:"Arpa",
                dm:89,
                ndf:20,
                starch:58,
                cp:12,
                adf:7,
                ndfd:65,
                price:10
            },

            soybeanMeal:{
                name:"Soya Küspesi",
                dm:89,
                ndf:12,
                starch:3,
                cp:48,
                adf:7,
                ndfd:60,
                price:18
            }

        },

        amounts:{

            cornSilage:12,

            alfalfaHay:4,

            cornGrain:4,

            barley:2,

            soybeanMeal:1

        },

        totalDM:0,

        totalNDF:0,

        forageNDF:0,

        starch:0,

        crudeProtein:0,

        ADF:0,

        FNDFD:0,

        forage:0,

        concentrate:0

    }

};


/* =========================================================
   İNEK
========================================================= */

function createCow(id){

    const weight =
        570+
        Math.random()*90;

    const potential =
        28+
        Math.random()*8;

    return{

        id:id,

        name:"İnek "+id,

        weight:Math.round(weight),

        lactationDay:
            Math.floor(
                Math.random()*180
            )+1,

        milkPotential:potential,

        milkYield:potential,

        /*
          Yeni sürü güne ilk sağım için hazır başlar.
          Sonraki doluluk, seçili sağım sıklığına göre dakika dakika oluşur.
        */
        udderFill:100,

        bcs:
            2.8+
            Math.random()*.5,

        health:100,

        rumenPH:6.1,

        saraRisk:0,

        energyBalance:0,

        diseaseRisk:0,

        breed:"Holstein",
        earTag:"TR-"+String(id).padStart(4,"0"),
        birthDate:"",
        lactationNumber:1,
        sex:"Dişi",
        purchaseDate:"",
        healthHistory:[],
        milkHistory:[],
        reproduction:{
            status:"Laktasyonda",
            heatDay:null,
            inseminationDay:null,
            pregnancyCheckDay:null,
            pregnant:false,
            expectedCalvingDay:null,
            lastCalvingDay:null,
            dryOffDay:null,
            nextHeatDay:50
        }

    };

}


/* =========================================================
   SÜRÜ OLUŞTUR
========================================================= */

function createInitialHerd(){
    game.cows=[];
}


/* =========================================================
   YENİ ÇİFTLİK
========================================================= */

function startFreshFarm(){
    game.saveVersion=SAVE_VERSION;
    game.day=1;
    game.minute=360;
    game.money=0;
    game.feed=STARTING_FEED_SUPPORT;
    game.totalMilk=0;
    game.todayMilk=0;
    game.rawMilkStock=0;
    game.rawMilkTankCapacity=2000;
    game.processingQueue=[];
    game.coldStorage={pasteurizedMilk:0,yogurt:0,cheese:0};
    game.processedProducts={pasteurizedMilk:0,yogurt:0,cheese:0};
    game.veterinary={
        invoices:[],
        totalInvoiced:0,
        totalPaid:0,
        maxOutstanding:20000
    };
    game.income=0;
    game.expenses=0;
    game.veterinary={debts:[],totalDebt:0,totalPaid:0};
    game.milkingStrategy=3;
    game.milkingWorker={
        hired:false,
        name:"Sağım İşçisi",
        hireCost:2500,
        dailyWage:750,
        hiredDay:null
    };
    game.pendingMilkingStrategy=null;
    game.lastRealTime=Date.now();
    game.lastMilking="";
    game.lastMilkingSlot="";
    game.lastAutomaticMilkingDay=0;
    game.lastAutomaticMilkingHour=-1;
    game.accountingLedger=[];
    game.messages=[];
    game.notificationState={lowFeed:false,criticalFeed:false,health:{},sara:{},udder:{},milkDrop:{},reproduction:{}};
    game.onboardingStep=1;
    game.cows=[];
    updateRationAnalysis();

    /* Oyunun hikâyesi sistem mesajıyla başlar. */
    game.money=STARTING_DONATION;
    game.income=STARTING_DONATION;
    game.accountingLedger.unshift({
        day:1,
        time:"06:00",
        type:"Gelir",
        category:"Başlangıç Bağışı",
        amount:STARTING_DONATION
    });
    game.accountingLedger.unshift({day:1,time:"06:00",type:"Destek",category:"Başlangıç Yem Desteği",amount:STARTING_FEED_SUPPORT});

    addNotification(
        "Sistem Desteği",
        "Hoş geldin çiftlik sahibi. Başlangıç paketin 35.000 ₺ destek ve 750 kg yem desteği içeriyor. İlk hedefin: ilk ineğini satın almak ve küçük sürünü sağlıklı biçimde büyütmek.",
        "success",
        false
    );

    localStorage.removeItem("ciftlikLogs");
    addLog("🎁 Başlangıç desteği: 35.000 ₺ + 750 kg yem.");
}


/* =========================================================
   KAYDET
========================================================= */

function saveGame(){
    queueSharedBackendSave();


    game.lastRealTime =
        Date.now();

    localStorage.setItem(
        "ciftlikSimulasyonu",
        JSON.stringify(game)
    );

}


/* =========================================================
   YÜKLE
========================================================= */

function loadGame(){

    const saved =
        localStorage.getItem(
            "ciftlikSimulasyonu"
        );

    if(!saved){

        startFreshFarm();
        updateRationAnalysis();
        return;

    }

    try{

        const old =
            JSON.parse(saved);

        /* Eski 24 hayvanlı kayıt bu sürümde geçerli değil: çiftlik yeniden kuruluyor. */
        if(old.saveVersion!==SAVE_VERSION){
            localStorage.removeItem("ciftlikSimulasyonu");
            startFreshFarm();
            updateRationAnalysis();
            return;
        }

        game={
            ...game,
            ...old,
            milkingWorker:{
                hired:false,name:"Sağım İşçisi",hireCost:2500,dailyWage:750,hiredDay:null,
                ...(old.milkingWorker||{})
            },
            rawMilkStock:Number(old.rawMilkStock)||0,
            veterinary:{
                debts:[],
                totalDebt:0,
                totalPaid:0,
                ...(old.veterinary||{})
            },
            bank:{
                loans:[],
                grantApplications:[],
                totalBorrowed:0,
                totalRepaid:0,
                totalGrantIncome:0,
                ...(old.bank||{})
            },
            veterinary:{
                invoices:[],
                totalInvoiced:0,
                totalPaid:0,
                maxOutstanding:20000,
                ...(old.veterinary||{})
            },
            rawMilkTankCapacity:Number(old.rawMilkTankCapacity)||2000,
            processingQueue:Array.isArray(old.processingQueue)?old.processingQueue:[],
            coldStorage:{pasteurizedMilk:0,yogurt:0,cheese:0,...(old.coldStorage||{})},
            processedProducts:{pasteurizedMilk:0,yogurt:0,cheese:0,...(old.processedProducts||{})}
        };

        game.pendingMilkingStrategy =
            game.pendingMilkingStrategy===undefined
            ? null
            : game.pendingMilkingStrategy;

        game.lastMilkingSlot =
            game.lastMilkingSlot||"";

        game.cows.forEach(cow=>{
            if(cow.udderFill===undefined) cow.udderFill=100;
            cow.udderFill=Math.max(0,Math.min(100,Number(cow.udderFill)||0));
        });

        game.accountingLedger =
            Array.isArray(game.accountingLedger)
            ? game.accountingLedger
            : [];


        /*
          Yeni rasyon sistemi.
        */

        if(
            !game.ration ||
            !game.ration.ingredients
        ){

            game.ration={
                ...game.ration,

                ingredients:{

                    cornSilage:{
                        name:"Mısır Silajı",
                        dm:35,
                        ndf:42,
                        starch:30,
                        cp:8,
                        adf:25,
                        ndfd:45,
                        price:4.5
                    },

                    alfalfaHay:{
                        name:"Yonca Kuru Otu",
                        dm:90,
                        ndf:40,
                        starch:5,
                        cp:18,
                        adf:30,
                        ndfd:50,
                        price:9
                    },

                    cornGrain:{
                        name:"Mısır Dane",
                        dm:88,
                        ndf:10,
                        starch:72,
                        cp:9,
                        adf:3,
                        ndfd:80,
                        price:11
                    },

                    barley:{
                        name:"Arpa",
                        dm:89,
                        ndf:20,
                        starch:58,
                        cp:12,
                        adf:7,
                        ndfd:65,
                        price:10
                    },

                    soybeanMeal:{
                        name:"Soya Küspesi",
                        dm:89,
                        ndf:12,
                        starch:3,
                        cp:48,
                        adf:7,
                        ndfd:60,
                        price:18
                    }

                },

                amounts:{
                    cornSilage:12,
                    alfalfaHay:4,
                    cornGrain:4,
                    barley:2,
                    soybeanMeal:1
                }

            };

        }


        if(
            !game.ration.amounts
        ){

            game.ration.amounts={
                cornSilage:12,
                alfalfaHay:4,
                cornGrain:4,
                barley:2,
                soybeanMeal:1
            };

        }


        game.cows.forEach(
            cow=>{

                if(cow.milkYield===undefined)
                    cow.milkYield=
                        cow.milkPotential;

                if(cow.rumenPH===undefined)
                    cow.rumenPH=6.1;

                if(cow.saraRisk===undefined)
                    cow.saraRisk=0;

                if(cow.energyBalance===undefined)
                    cow.energyBalance=0;

                if(cow.diseaseRisk===undefined)
                    cow.diseaseRisk=0;
                if(!Array.isArray(cow.healthHistory))
                    cow.healthHistory=[];
                if(!Array.isArray(cow.milkHistory))
                    cow.milkHistory=[];
                if(!cow.reproduction)
                    cow.reproduction={status:"Laktasyonda"};
                cow.reproduction={
                    status:"Laktasyonda",
                    heatDay:null,
                    inseminationDay:null,
                    pregnancyCheckDay:null,
                    pregnant:false,
                    expectedCalvingDay:null,
                    lastCalvingDay:null,
                    dryOffDay:null,
                    nextHeatDay:null,
                    ...cow.reproduction
                };
                if(!cow.breed) cow.breed="Holstein";
                if(!cow.earTag) cow.earTag="TR-"+String(cow.id).padStart(4,"0");
                if(!cow.sex) cow.sex="Dişi";
                if(cow.lactationNumber===undefined) cow.lactationNumber=1;

            }
        );


        updateRationAnalysis();

        calculateOfflineProgress();

    }

    catch(error){

        console.error(error);

        createInitialHerd();

        updateRationAnalysis();

    }

}


/* =========================================================
   RASYON ANALİZİ
========================================================= */

function calculateRation(){

    const r =
        game.ration;

    let totalDM=0;

    let ndf=0;

    let starch=0;

    let cp=0;

    let adf=0;

    let forageNDF=0;

    let forageDM=0;

    let concentrateDM=0;

    let weightedNDFD=0;


    Object.entries(
        r.amounts
    ).forEach(
        ([key,amount])=>{

            const feed =
                r.ingredients[key];

            if(!feed)
                return;

            const safeAmount =
                Math.max(
                    0,
                    Number(amount)||0
                );


            const dm =
                safeAmount*
                (
                    feed.dm/
                    100
                );


            totalDM+=dm;


            ndf+=
                dm*
                (
                    feed.ndf/
                    100
                );


            starch+=
                dm*
                (
                    feed.starch/
                    100
                );


            cp+=
                dm*
                (
                    feed.cp/
                    100
                );


            adf+=
                dm*
                (
                    feed.adf/
                    100
                );


            weightedNDFD+=
                dm*
                (
                    feed.ndfd/
                    100
                );


            if(
                key==="cornSilage" ||
                key==="alfalfaHay"
            ){

                forageNDF+=
                    dm*
                    (
                        feed.ndf/
                        100
                    );

                forageDM+=dm;

            }

            else{

                concentrateDM+=dm;

            }

        }
    );


    if(totalDM<=0){

        return{

            dm:0,
            ndf:0,
            starch:0,
            cp:0,
            adf:0,
            forageNDF:0,
            forage:0,
            concentrate:0,
            ndfd:0

        };

    }


    return{

        dm:totalDM,

        ndf:
            (
                ndf/
                totalDM
            )*
            100,

        starch:
            (
                starch/
                totalDM
            )*
            100,

        cp:
            (
                cp/
                totalDM
            )*
            100,

        adf:
            (
                adf/
                totalDM
            )*
            100,

        forageNDF:
            (
                forageNDF/
                totalDM
            )*
            100,

        forage:
            (
                forageDM/
                totalDM
            )*
            100,

        concentrate:
            (
                concentrateDM/
                totalDM
            )*
            100,

        ndfd:
            (
                weightedNDFD/
                totalDM
            )*
            100

    };

}


/* =========================================================
   RASYON DEĞERLERİNİ OYUNA AKTAR
========================================================= */

function updateRationAnalysis(){

    const analysis =
        calculateRation();


    game.ration.totalDM =
        analysis.dm;

    game.ration.totalNDF =
        analysis.ndf;

    game.ration.starch =
        analysis.starch;

    game.ration.crudeProtein =
        analysis.cp;

    game.ration.ADF =
        analysis.adf;

    game.ration.forageNDF =
        analysis.forageNDF;

    game.ration.forage =
        analysis.forage;

    game.ration.concentrate =
        analysis.concentrate;

    game.ration.FNDFD =
        analysis.ndfd;

}


/* =========================================================
   YEM MİKTARI DEĞİŞTİR
========================================================= */

function updateFeedAmount(
    key,
    value
){

    if(
        !game.ration.amounts[key]
        &&
        game.ration.amounts[key]!==0
    ){

        return;

    }


    game.ration.amounts[key] =
        Math.max(
            0,
            Number(value)||0
        );


    updateRationAnalysis();

    render();

    saveGame();

}


/* =========================================================
   RASYON UYARILARI
========================================================= */

function getRationWarnings(){

    const r =
        game.ration;

    const warnings=[];


    if(
        r.starch>28
    ){

        warnings.push(
            "⚠ Yüksek nişasta: rumen asidozu/Subakut Rumen Asidozu (SARA) riskii artabilir."
        );

    }


    if(
        r.starch<18
    ){

        warnings.push(
            "ℹ Nişasta düzeyi düşük; yüksek verimli hayvanlarda enerji arzı ayrıca değerlendirilmelidir."
        );

    }


    if(
        r.totalNDF<28
    ){

        warnings.push(
            "⚠ Toplam NDF düşük."
        );

    }


    if(
        r.totalNDF>40
    ){

        warnings.push(
            "⚠ Toplam NDF yüksek; DMI sınırlanabilir."
        );

    }


    if(
        r.forageNDF<18
    ){

        warnings.push(
            "⚠ Forage NDF düşük; fiziksel etkin lif açısından dikkat."
        );

    }


    if(
        r.crudeProtein<14
    ){

        warnings.push(
            "⚠ Ham protein düşük."
        );

    }


    if(
        r.crudeProtein>19
    ){

        warnings.push(
            "ℹ Ham protein yüksek; protein/enerji dengesi değerlendirilmelidir."
        );

    }


    if(
        warnings.length===0
    ){

        warnings.push(
            "✓ Rasyon temel simülasyon sınırları içerisinde."
        );

    }


    return warnings;

}


/* =========================================================
   DMI
========================================================= */

function calculateDMI(cow){

    const r =
        game.ration;


    const MY =
        cow.milkYield*
        2.20462;


    const ADF_NDF =
        r.ADF/
        Math.max(
            0.01,
            r.totalNDF
        );


    let dmiLb =

        12.0

        -0.107*
        r.forageNDF

        +8.17*
        ADF_NDF

        +0.0253*
        r.FNDFD

        -0.328*
        (
            ADF_NDF-
            0.602
        )*
        (
            r.FNDFD-
            48.3
        )

        +0.225*
        MY

        +0.00390*
        (
            r.FNDFD-
            48.3
        )*
        (
            MY-
            33.1
        );


    let dmiKg =
        dmiLb*
        0.453592;


    dmiKg =
        Math.max(
            8,
            Math.min(
                30,
                dmiKg
            )
        );


    if(cow.bcs<2.5){

        dmiKg*=0.95;

    }


    if(cow.health<80){

        dmiKg*=
            0.95+
            (
                cow.health/
                1000
            );

    }


    return dmiKg;

}


/* =========================================================
   WOOD
========================================================= */

function calculateMilkProduction(cow){

    if(cow.isCalf || cow.sex==="Erkek"){
        return 0;
    }

    if(cow.reproduction?.status==="Kuru Dönem"){
        return 0;
    }

    const t =
        Math.max(
            1,
            cow.lactationDay
        );


    const b=0.18;
    const c=0.003;


    const safePotential=Math.max(18,Number(cow.milkPotential)||28);
    const a=safePotential*1.8;
    let milk =
        a*
        Math.pow(t,b)*
        Math.exp(-c*t);


    const bcsPenalty =
        Math.abs(
            cow.bcs-
            3.0
        )*
        0.08;


    milk*=
        1-
        bcsPenalty;


    milk*=
        cow.health/
        100;


    if(
        cow.rumenPH<5.8
    ){

        milk*=0.95;

    }


    if(
        cow.rumenPH<5.5
    ){

        milk*=0.88;

    }


    if(
        cow.udderFill>100
    ){

        const penalty =
            Math.min(
                0.30,
                (
                    cow.udderFill-
                    100
                )/
                100
            );


        milk*=
            1-
            penalty;

    }


    return Math.max(
        0,
        milk
    );

}


/* =========================================================
   RUMEN pH
========================================================= */

function calculateRumenPH(cow){

    const r =
        game.ration;


    let ph=6.2;


    ph+=
        (
            r.totalNDF-
            30
        )*
        0.025;


    ph-=
        (
            r.starch-
            20
        )*
        0.035;


    ph-=
        Math.max(
            0,
            r.concentrate-
            45
        )*
        0.015;


    ph+=
        (
            r.forageNDF-
            20
        )*
        0.01;


    return Math.max(
        5.2,
        Math.min(
            6.6,
            ph
        )
    );

}


/* =========================================================
   SARA
========================================================= */

function calculateSARARisk(cow){

    const ph =
        cow.rumenPH;


    if(ph>=5.8)
        return 0;


    if(ph>=5.6)
        return 25;


    if(ph>=5.4)
        return 55;


    return 85;

}


/* =========================================================
   BİYOLOJİ
========================================================= */

function processCalfBiology(cow){
    if(!cow.isCalf) return;

    const care=cow.calfCare||(cow.calfCare={
        colostrumReceived:true,
        milkFedDays:0,
        weaningDay:null,
        weaned:false,
        starterFeedIntake:0,
        lastCareDay:null
    });

    if(care.lastCareDay===game.day) return;
    care.lastCareDay=game.day;

    const age=Number(cow.ageDays)||0;

    if(age<=3){
        if(!care.colostrumReceived){
            cow.health-=2;
            cow.diseaseRisk=Math.min(100,(cow.diseaseRisk||0)+8);
        }else{
            cow.health=Math.min(100,(cow.health||100)+0.2);
        }
    }

    if(age<=60){
        care.milkFedDays++;
        cow.weight+=0.70;
        care.starterFeedIntake+=0.15;
    }else if(age<=90){
        care.milkFedDays++;
        cow.weight+=0.78;
        care.starterFeedIntake+=0.90;
    }else{
        cow.weight+=0.70;
        care.starterFeedIntake+=2.50;
    }

    if(age===60 && !care.weaningDay){
        care.weaningDay=game.day+30;
        addNotification(
            "Buzağı Sütten Kesim",
            cow.name+" için kademeli sütten kesim başladı. Başlangıç yemi artırılıyor.",
            "info",
            true
        );
    }

    if(age>=90 && !care.weaned){
        care.weaned=true;
        addAnimalHealthRecord(cow,"Buzağı Bakımı","Sütten kesim tamamlandı");
        addNotification(
            "Sütten Kesim Tamamlandı",
            cow.name+" sütten kesildi ve genç hayvan dönemine geçti.",
            "success",
            true
        );
    }

    if(age>90 && cow.weight<80){
        cow.diseaseRisk=Math.min(100,(cow.diseaseRisk||0)+0.5);
    }

    cow.bcs=Math.max(2.5,Math.min(3.5,Number(cow.bcs)||2.8));
    cow.health=Math.max(0,Math.min(100,Number(cow.health)||100));
}

function updateCowBiology(cow){

    if(cow.isCalf){
        processCalfBiology(cow);
        return;
    }

    cow.rumenPH =
        calculateRumenPH(
            cow
        );


    cow.saraRisk =
        calculateSARARisk(
            cow
        );


    if(
        cow.saraRisk>50
    ){

        cow.health-=0.002;

    }


    const dmi =
        calculateDMI(
            cow
        );


    const energyDemand =

        9+
        (
            cow.milkYield*
            0.70
        );


    const energySupply =

        dmi*
        1.60;


    cow.energyBalance =

        energySupply-
        energyDemand;


    if(
        cow.energyBalance<0
    ){

        cow.bcs-=0.0005;

    }


    if(
        cow.energyBalance>4 &&
        cow.lactationDay>100
    ){

        cow.bcs+=0.0001;

    }


    cow.diseaseRisk =

        (
            cow.saraRisk*
            0.45
        )

        +

        (
            Math.max(
                0,
                2.75-
                cow.bcs
            )*
            15
        )

        +

        (
            Math.max(
                0,
                85-
                cow.health
            )*
            0.25
        );


    cow.diseaseRisk =
        Math.max(
            0,
            Math.min(
                100,
                cow.diseaseRisk
            )
        );


    cow.bcs =
        Math.max(
            2,
            Math.min(
                4.5,
                cow.bcs
            )
        );


    cow.health =
        Math.max(
            0,
            Math.min(
                100,
                cow.health
            )
        );

}


/* =========================================================
   BİYOLOJİK TICK
========================================================= */

function getNextEstrousCycleDays(){
    return REPRODUCTION_CONFIG.estrousCycleMin+
        Math.floor(Math.random()*(REPRODUCTION_CONFIG.estrousCycleMax-REPRODUCTION_CONFIG.estrousCycleMin+1));
}

function processReproduction(cow){
    if(cow.isCalf){
        return;
    }
    const r=cow.reproduction||(cow.reproduction={status:"Laktasyonda"});
    const state=game.notificationState?.reproduction||(game.notificationState.reproduction={});
    const id=String(cow.id);
    const today=game.day;

    if(r.pregnant){
        const daysToCalving=(Number(r.expectedCalvingDay)||0)-today;

        /*
          Gerçekçi geçiş:
          Gebe hayvan, tahmini doğuma 60 gün kala otomatik olarak
          kuru döneme alınır. Böylece sağım doğumdan önce planlı şekilde durur.
          Doğum yine kullanıcı tarafından kaydedilir; bu sayede sürü sayısı
          ve buzağı kayıtları kontrolsüz şekilde değişmez.
        */
        if(
            r.status!=="Kuru Dönem" &&
            r.expectedCalvingDay &&
            daysToCalving<=REPRODUCTION_CONFIG.dryPeriodTargetDays &&
            daysToCalving>=0
        ){
            r.status="Kuru Dönem";
            r.dryOffDay=today;
            cow.milkYield=0;
            cow.udderFill=0;

            if(!state[id]) state[id]={};
            if(!state[id].autoDryOff){
                addAnimalHealthRecord(
                    cow,
                    "Üreme",
                    "Tahmini doğuma 60 gün kala otomatik kuruya çıkarıldı"
                );
                addNotification(
                    "Otomatik Kuruya Çıkarma",
                    cow.name+" tahmini doğuma "+daysToCalving+" gün kaldığı için kuru döneme alındı.",
                    "info",
                    true
                );
                state[id].autoDryOff=true;
            }
        }

        if(r.expectedCalvingDay && today>=r.expectedCalvingDay){
            if(!state[id]) state[id]={};
            if(!state[id].calvingDue){
                addNotification("Doğum Zamanı",cow.name+" için tahmini doğum tarihi geldi. Doğum kaydını oluştur.","warning",true);
                state[id].calvingDue=true;
            }
        }
        return;
    }

    if(r.status==="Kuru Dönem") return;

    if(r.status==="Kızgınlık" && r.heatDay && today-r.heatDay>=REPRODUCTION_CONFIG.heatDurationDays){
        r.status="Laktasyonda";
        r.nextHeatDay=today+getNextEstrousCycleDays();
    }

    if(r.inseminationDay) return;

    if(!r.nextHeatDay){
        const base=Math.max(today+REPRODUCTION_CONFIG.voluntaryWaitingDays,(r.lastCalvingDay||0)+REPRODUCTION_CONFIG.voluntaryWaitingDays);
        r.nextHeatDay=base+getNextEstrousCycleDays();
    }

    if(today>=r.nextHeatDay){
        r.status="Kızgınlık";
        r.heatDay=today;
        if(!state[id]) state[id]={};
        if(!state[id].heat) {
            addNotification("Otomatik Kızgınlık",cow.name+" için yeni kızgınlık dönemi başladı. Tohumlama planlanabilir.","warning",true);
            addAnimalHealthRecord(cow,"Üreme","Otomatik kızgınlık tespit edildi");
            state[id].heat=true;
        }
    }else{
        if(!state[id]) state[id]={};
        state[id].heat=false;
    }
}

function biologicalTick(){

    updateRationAnalysis();


    game.cows.forEach(
        cow=>{

            if(cow.isCalf){
                updateCowBiology(cow);
                cow.milkYield=0;
                cow.udderFill=0;
                return;
            }

            processReproduction(cow);

            updateCowBiology(
                cow
            );


            cow.milkYield =
                calculateMilkProduction(cow);
            if(!Number.isFinite(cow.milkYield) || cow.milkYield<0) cow.milkYield=0;


            const fillIncrease =
                cow.reproduction?.status==="Kuru Dönem"
                ? 0
                : 100/
                (1440/game.milkingStrategy);


            const previousFill=Number(cow.udderFill)||0;
            cow.udderFill=Math.min(100,previousFill+fillIncrease);

            /*
              Meme doluluğu 0–100 arasında tutulur.
              %100 planlı sağım için normaldir. Sağım kaçırıldığında
              yapay bir %100 üstü üretim cezası uygulanmaz; uzun süre
              tam dolulukta kalmak ise hafif sağlık baskısı oluşturur.
            */
            if(previousFill>=100){
                cow.health-=0.0002;
            }

        }
    );


    const totalDMI =

        game.cows.reduce(
            (
                sum,
                cow
            )=>

                cow.isCalf
                ? sum
                : sum+
                calculateDMI(
                    cow
                ),

            0
        );


    const feedPerMinute =
        totalDMI/
        1440;


    game.feed-=
        feedPerMinute;


    if(
        game.feed<=0
    ){

        game.feed=0;


        game.cows.forEach(
            cow=>{

                cow.health-=0.01;

                cow.energyBalance-=0.1;

            }
        );

    }


    game.expenses+=
        feedPerMinute*
        FEED_PRICE;

    checkSmartNotifications();

}


/* =========================================================
   OFFLINE
========================================================= */

function calculateOfflineProgress(){

    /*
      Ortak dünya saatinde cihazın kapalı kaldığı süre ayrıca hesaplanmaz.
      Açılışta doğrudan herkesle aynı dünya saatine bağlanılır.
    */
    const world=getSharedWorldTime();
    game.day=world.day;
    game.minute=world.minute;
    game.lastRealTime=Date.now();
}




/* =========================================================
   ZAMAN
========================================================= */

function processMilkFactory(minutes){
    game.processingQueue=Array.isArray(game.processingQueue)?game.processingQueue:[];
    game.coldStorage=game.coldStorage||{pasteurizedMilk:0,yogurt:0,cheese:0};
    for(const job of game.processingQueue) job.remainingMinutes=Math.max(0,(Number(job.remainingMinutes)||0)-minutes);
    const done=game.processingQueue.filter(j=>j.remainingMinutes<=0);
    game.processingQueue=game.processingQueue.filter(j=>j.remainingMinutes>0);
    done.forEach(job=>{
        game.coldStorage[job.product]=(Number(game.coldStorage[job.product])||0)+Number(job.output||0);
        game.processedProducts[job.product]=(Number(game.processedProducts[job.product])||0)+Number(job.output||0);
        addNotification("Üretim Tamamlandı",job.output.toFixed(1)+" birim ürün soğuk depoya alındı.","success",true);
    });
}

function expireProcessedProducts(){
    game.coldStorage=game.coldStorage||{pasteurizedMilk:0,yogurt:0,cheese:0};
    game.coldStorage._age=game.coldStorage._age||{pasteurizedMilk:0,yogurt:0,cheese:0};
    const shelf={pasteurizedMilk:5,yogurt:10,cheese:30};
    Object.keys(shelf).forEach(product=>{
        if((Number(game.coldStorage[product])||0)>0){
            game.coldStorage._age[product]=(Number(game.coldStorage._age[product])||0)+1;
            if(game.coldStorage._age[product]>=shelf[product]){
                const lost=game.coldStorage[product];
                game.coldStorage[product]=0; game.processedProducts[product]=0; game.coldStorage._age[product]=0;
                addNotification("Ürün Bozuldu",lost.toFixed(1)+" birim ürün raf ömrünü doldurdu ve imha edildi.","warning",true);
            }
        }
    });
}

function advanceGameTime(minutes){

    for(
        let i=0;
        i<minutes;
        i++
    ){

        game.minute++;
        processMilkFactory(1);

        if(
            game.minute>=1440
        ){

            game.minute=0;

            game.day++;

            game.todayMilk=0;
            expireProcessedProducts();
            processBankDay();
            processVeterinaryDebts();

            const worker=game.milkingWorker||{};
            if(worker.hired){
                const wage=Number(worker.dailyWage)||750;
                game.money-=wage; game.expenses+=wage;
                game.accountingLedger=game.accountingLedger||[];
                game.accountingLedger.unshift({day:game.day,time:"00:00",type:"Gider",category:"Sağım İşçisi Günlük Ücret",amount:wage});
                addLog("💰 Sağım işçisi günlük ücreti ödendi: "+wage.toLocaleString("tr-TR")+" ₺");
            }

            if(game.pendingMilkingStrategy){
                game.milkingStrategy=game.pendingMilkingStrategy;
                game.pendingMilkingStrategy=null;
                addLog(`Yeni gün: sağım programı ${game.milkingStrategy}X olarak aktif.`);
            }


            game.cows.forEach(
                cow=>{
                    if(cow.isCalf){
                        cow.ageDays=(Number(cow.ageDays)||0)+1;

                        if(cow.ageDays>=730){
                            cow.isCalf=false;

                            if(cow.sex==="Dişi"){
                                cow.reproduction={
                                    status:"Düve",
                                    heatDay:null,
                                    inseminationDay:null,
                                    pregnancyCheckDay:null,
                                    pregnant:false,
                                    expectedCalvingDay:null,
                                    lastCalvingDay:null,
                                    dryOffDay:null,
                                    nextHeatDay:game.day+getNextEstrousCycleDays()
                                };
                                cow.lactationNumber=0;
                                cow.lactationDay=0;
                                cow.milkPotential=28+Math.random()*8;
                                cow.milkYield=0;
                                addNotification("Düve Dönemi",cow.name+" 24 aylık oldu ve düve olarak sürüye katıldı.","success",true);
                            }else{
                                cow.reproduction.status="Boğa";
                                addNotification("Erginlik",cow.name+" 24 aylık oldu ve ergin erkek hayvan olarak kaydedildi.","info",true);
                            }
                        }
                    }else if(cow.reproduction?.status!=="Kuru Dönem" && cow.sex!=="Erkek"){
                        cow.lactationDay++;
                    }
                }
            );


            addLog(
                `Yeni gün başladı: ${game.day}. gün`
            );

        }


        biologicalTick();

        processAutomaticMilking();

    }

}


/* =========================================================
   SAĞIM
========================================================= */

function getAutomaticMilkingHours(){

    if(game.milkingStrategy===2) return [6,18];

    if(game.milkingStrategy===3) return [6,14,22];

    return [0,6,12,18];

}


const MILKING_MANUAL_WINDOW_MINUTES=8;

function getMilkingScheduleInfo(){
    const minute=Math.max(0,Math.min(1439,Number(game.minute)||0));
    const day=Math.max(1,Number(game.day)||1);
    const hours=getAutomaticMilkingHours();
    for(const hour of hours){
        const scheduled=hour*60;
        const diff=minute-scheduled;
        if(diff>=0 && diff<=MILKING_MANUAL_WINDOW_MINUTES){
            return {day,hour,scheduled,diff};
        }
    }
    return null;
}

function isMilkingTime(){
    /*
      Ortak dünya saati saniyede 4 oyun dakikası ilerlediği için
      tam 00. dakikaya dokunmak zorunlu değildir.
      Programlı saatten sonraki ilk 8 oyun dakikası manuel sağım penceresidir.
    */
    return !!getMilkingScheduleInfo();
}

function getMilkingSlotKey(){
    const info=getMilkingScheduleInfo();
    if(info) return info.day+"-"+info.hour;
    return game.day+"-none";
}

function hireMilkingWorker(){
    game.milkingWorker=game.milkingWorker||{hired:false,name:"Sağım İşçisi",hireCost:2500,dailyWage:750,hiredDay:null};
    if(game.milkingWorker.hired) return;
    const cost=Number(game.milkingWorker.hireCost)||2500;
    if(game.money<cost){addLog("⚠ Sağım işçisi için "+cost.toLocaleString("tr-TR")+" ₺ gerekiyor.");return;}
    game.money-=cost; game.expenses+=cost;
    game.milkingWorker.hired=true; game.milkingWorker.hiredDay=game.day;
    game.accountingLedger=game.accountingLedger||[];
    game.accountingLedger.unshift({day:game.day,time:formatGameTime(),type:"Gider",category:"Sağım İşçisi İşe Alım",amount:cost});
    addNotification("Sağım İşçisi İşe Alındı","Programlı saatlerde sürüyü otomatik sağacak. Günlük ücret: "+(Number(game.milkingWorker.dailyWage)||750).toLocaleString("tr-TR")+" ₺.","success",true);
    addLog("👨‍🌾 Sağım işçisi işe alındı. Programlı sağım otomatik yapılacak.");
    render(); saveGame();
}

function processAutomaticMilking(){

    if(!isMilkingTime()) return;
    if(!(game.milkingWorker||{}).hired) return;

    const slot=getMilkingSlotKey();

    if(game.lastMilkingSlot===slot) return;

    milkHerd(true);

}


function milkHerd(automatic=false){

    if(!isMilkingTime()){

        if(!automatic){
            const hours=getAutomaticMilkingHours();
            const now=Math.max(0,Math.min(1439,Number(game.minute)||0));
            let next=hours.find(h=>h*60>now);
            if(next===undefined) next=hours[0]+24;

            const nextText=String(next%24).padStart(2,"0")+":00";
            addLog("⚠ Sağım zamanı değil. Sonraki programlı sağım: "+nextText+" | Program: "+hours.map(h=>String(h).padStart(2,"0")+":00").join(", ")+" | Program saatinden sonra "+MILKING_MANUAL_WINDOW_MINUTES+" dk içinde manuel sağım yapılabilir.");
        }

        return;

    }

    const slot=getMilkingSlotKey();

    if(game.lastMilkingSlot===slot){

        if(!automatic){
            addLog("⚠ Bu sağım saati zaten tamamlandı.");
        }

        return;

    }


    let milk=0;
    let stressed=0;
    const frequency=game.milkingStrategy;


    game.cows.forEach(cow=>{

        if(cow.reproduction?.status==="Kuru Dönem"){
            cow.udderFill=0;
            return;
        }

        const fillRatio=Math.max(0,Math.min(1,Number(cow.udderFill)||0)/100);
        const yieldAmount=(cow.milkYield/frequency)*fillRatio;

        /*
          Sağım miktarı gerçek meme doluluğuna göre belirlenir.
          Doluluk %100'ü aşmadığı için birkaç dakikalık gecikme
          anlamsız bir üretim cezası oluşturmaz.
        */
        milk+=Math.max(0,yieldAmount);
        cow.udderFill=0;

        cow.milkHistory=Array.isArray(cow.milkHistory)?cow.milkHistory:[];
        cow.milkHistory.unshift({
            day:game.day,
            time:formatGameTime(),
            yield:Math.max(0,yieldAmount)
        });
        cow.milkHistory=cow.milkHistory.slice(0,30);

    });


    /*
      Sağım sıklığına küçük ve sabit bir yönetim katsayısı.
      2X temel, 3X hafif verim artışı, 4X robotik sistem primi.
    */
    if(frequency===3) milk*=1.02;
    if(frequency===4) milk*=1.04;


    milk=Math.max(0,milk);

    game.totalMilk+=milk;
    game.todayMilk+=milk;

    const tankCapacity=Number(game.rawMilkTankCapacity)||2000;
    const available=Math.max(0,tankCapacity-(Number(game.rawMilkStock)||0));
    const accepted=Math.min(milk,available);
    const overflow=Math.max(0,milk-accepted);
    game.rawMilkStock=(Number(game.rawMilkStock)||0)+accepted;
    if(overflow>0){
        const overflowIncome=overflow*MILK_PRICE;
        game.money+=overflowIncome; game.income+=overflowIncome;
        recordAccounting("Gelir","Tank Kapasitesi Aşımı - Çiğ Süt Satışı",overflowIncome);
        addLog("⚠ Tank dolu: "+overflow.toFixed(1)+" L süt otomatik satıldı.");
    }

    game.lastMilking=formatGameTime();
    game.lastMilkingSlot=slot;

    game.accountingLedger=game.accountingLedger||[];
    addNotification(
        automatic ? "Otomatik Sağım Tamamlandı" : "Sağım Tamamlandı",
        `${milk.toFixed(1)} L süt elde edildi ve süt tankına alındı.`,
        "success",
        true
    );

    addLog(
        `${automatic ? "Otomatik" : "Manuel"} sağım tamamlandı: ${milk.toFixed(1)} L | Süt tankına alındı`
    );


    render();
    saveGame();

}


function sellRawMilk(){
    const liters=Math.max(0,Number(game.rawMilkStock)||0);
    if(liters<0.1){addLog("⚠ Satılacak çiğ süt bulunmuyor.");return;}
    const income=liters*MILK_PRICE;
    game.rawMilkStock=0;
    game.money+=income; game.income+=income;
    recordAccounting("Gelir","Çiğ Süt Satışı",income);
    addNotification("Çiğ Süt Satıldı",liters.toFixed(1)+" L çiğ süt "+income.toFixed(0)+" ₺ gelirle satıldı.","success",true);
    render(); saveGame();
}

function processMilk(product){
    const stock=Math.max(0,Number(game.rawMilkStock)||0);
    game.processedProducts=game.processedProducts||{pasteurizedMilk:0,yogurt:0,cheese:0};
    game.processingQueue=Array.isArray(game.processingQueue)?game.processingQueue:[];
    const cfg={
        pasteurizedMilk:{name:"Pastörize Süt",need:1,output:0.98,price:32,cost:2.2,hours:2,shelf:5},
        yogurt:{name:"Yoğurt",need:1,output:1.02,price:55,cost:5.5,hours:6,shelf:10},
        cheese:{name:"Peynir",need:10,output:1,price:240,cost:18,hours:24,shelf:30}
    }[product];
    if(!cfg)return;
    if(stock<cfg.need){addLog("⚠ "+cfg.name+" için en az "+cfg.need+" L çiğ süt gerekiyor.");return;}
    const batches=Math.floor(stock/cfg.need);
    const used=batches*cfg.need;
    const output=batches*cfg.output;
    const processingCost=used*cfg.cost;
    if(game.money<processingCost){addLog("⚠ İşleme maliyeti için "+processingCost.toFixed(0)+" ₺ gerekiyor.");return;}
    game.rawMilkStock-=used;
    game.money-=processingCost; game.expenses+=processingCost;
    game.processingQueue.push({
        product,output,remainingMinutes:cfg.hours*60,
        shelfDays:cfg.shelf,
        createdDay:game.day
    });
    recordAccounting("Gider",cfg.name+" İşleme",processingCost);
    addNotification("Üretim Başlatıldı",cfg.name+" üretimi "+cfg.hours+" saat içinde tamamlanacak.","success",true);
    addLog("🏭 "+cfg.name+" üretimi başladı: "+used.toFixed(1)+" L süt işlendi.");
    render(); saveGame();
}

function sellProcessedMilk(product){
    game.coldStorage=game.coldStorage||{pasteurizedMilk:0,yogurt:0,cheese:0};
    const cfg={pasteurizedMilk:{name:"Pastörize Süt",price:32},yogurt:{name:"Yoğurt",price:55},cheese:{name:"Peynir",price:240}}[product];
    if(!cfg)return;
    const qty=Math.max(0,Number(game.coldStorage[product])||0);
    if(qty<0.01){addLog("⚠ Soğuk depoda satılacak "+cfg.name.toLowerCase()+" bulunmuyor.");return;}
    const income=qty*cfg.price;
    game.coldStorage[product]=0;
    game.processedProducts[product]=0;
    game.money+=income; game.income+=income;
    recordAccounting("Gelir",cfg.name+" Satışı",income);
    addNotification(cfg.name+" Satıldı",qty.toFixed(1)+" birim ürün "+income.toFixed(0)+" ₺ gelir getirdi.","success",true);
    render(); saveGame();
}
/* =========================================================
   SAĞIM STRATEJİSİ
========================================================= */

function setMilkingStrategy(times){

    if(![2,3,4].includes(times)) return;

    if(game.milkingStrategy===times && !game.pendingMilkingStrategy){
        addLog(`Sağım programı zaten ${times}X.`);
        return;
    }

    game.pendingMilkingStrategy=times;

    addLog(
        `Sağım programı ${times}X olarak seçildi. Program değişikliği yeni gün 00:00'da devreye girecek.`
    );

    render();
    saveGame();

}


/* =========================================================
   HAYVAN EKLE
========================================================= */

function addCow(){

    if(game.money<COW_PURCHASE_PRICE){
        addLog(`⚠ İlk hayvan için ${COW_PURCHASE_PRICE.toLocaleString("tr-TR")} ₺ gerekiyor.`);
        return;
    }

    const id=game.cows.length+1;

    game.money-=COW_PURCHASE_PRICE;
    game.expenses+=COW_PURCHASE_PRICE;
    recordAccounting("Gider","Hayvan Alımı",COW_PURCHASE_PRICE);

    game.cows.push(createCow(id));

    game.onboardingStep=Math.max(game.onboardingStep||1,2);

    addNotification(
        "Hayvan Alımı",
        `İnek ${id} çiftliğine geldi. Şimdi ona düzenli yem ve bakım sağlayarak sürünü yavaş yavaş büyütebilirsin.`,
        "success",
        true
    );

    addLog(`🐄 İnek ${id} satın alındı. Maliyet: ${COW_PURCHASE_PRICE.toLocaleString("tr-TR")} ₺`);
    render();
    saveGame();

}


/* =========================================================
   YEM AL
========================================================= */

function accountingBuyFeed(amount){

    const cost=amount*FEED_PRICE;

    if(game.money<cost){
        addLog("⚠ Muhasebe: Yem alımı için yeterli nakit yok.");
        return;
    }

    game.money-=cost;
    game.expenses+=cost;
    game.feed+=amount;

    recordAccounting("Gider","Yem Alımı",cost);
    game.notificationState=game.notificationState||{};
    game.notificationState.lowFeed=false;
    game.notificationState.criticalFeed=false;
    addNotification("Yem Alındı",`${amount.toLocaleString("tr-TR")} kg yem depoya eklendi. Maliyet: ${cost.toLocaleString("tr-TR")} ₺.`,"success",true);

    addLog(
        `${amount.toLocaleString("tr-TR")} kg yem alındı. Maliyet: ${cost.toLocaleString("tr-TR")} ₺`
    );

    render();
    saveGame();

}


function buyFeed(){
    accountingBuyFeed(500);
}


function accountingPayment(category,amount){

    if(game.money<amount){
        addLog(`⚠ Muhasebe: ${category} ödemesi için yeterli nakit yok.`);
        return;
    }

    game.money-=amount;
    game.expenses+=amount;

    recordAccounting("Gider",category,amount);

    addLog(
        `Muhasebe ödemesi: ${category} — ${amount.toLocaleString("tr-TR")} ₺`
    );

    render();
    saveGame();

}


function ensureBankState(){
    game.bank=game.bank||{};
    game.bank.loans=Array.isArray(game.bank.loans)?game.bank.loans:[];
    game.bank.grantApplications=Array.isArray(game.bank.grantApplications)?game.bank.grantApplications:[];
    game.bank.loanApplications=Array.isArray(game.bank.loanApplications)?game.bank.loanApplications:[];
    game.bank.totalBorrowed=Number(game.bank.totalBorrowed)||0;
    game.bank.totalRepaid=Number(game.bank.totalRepaid)||0;
    game.bank.totalGrantIncome=Number(game.bank.totalGrantIncome)||0;
    return game.bank;
}

function getBankProfile(){
    const cows=Array.isArray(game.cows)?game.cows:[];
    const adults=cows.filter(c=>!c.isCalf);
    const healthy=adults.filter(c=>Number(c.health??100)>=70).length;
    const milk=Number(game.todayMilk)||0;
    const income=Number(game.income)||0;
    const expenses=Number(game.expenses)||0;
    const debt=ensureBankState().loans.reduce((s,l)=>s+Number(l.remaining||0),0);
    const farmValue=adults.length*25000+Number(game.money||0)+Number(game.feed||0)*19.07;
    const monthlyNet=Math.max(0,income-expenses);
    const healthScore=adults.length?healthy/adults.length*20:0;
    const herdScore=Math.min(25,adults.length/20*25);
    const cashScore=Math.min(20,Math.max(0,Number(game.money||0))/50000*20);
    const productionScore=Math.min(20,milk/300*20);
    const debtScore=debt<=0?15:Math.max(0,15-debt/10000);
    const stabilityScore=Math.min(20,monthlyNet/10000*20);
    const score=Math.round(Math.min(100,healthScore+herdScore+cashScore+productionScore+debtScore+stabilityScore));
    return {score,adults:adults.length,healthy, milk,income,expenses,debt,farmValue,monthlyNet};
}

function evaluateBankApplication(app){
    const p=getBankProfile();
    const requested=Number(app.amount)||0;
    const cfg=app.cfg||{};
    let score=p.score;
    const debtRatio=p.farmValue>0?p.debt/p.farmValue:1;
    if(requested>p.farmValue*0.35) score-=15;
    if(debtRatio>0.25) score-=15;
    if(p.adults<5 && app.type!=="işletme") score-=8;
    if(p.monthlyNet<requested/(Number(cfg.months)||12)) score-=10;
    score=Math.max(0,Math.min(100,Math.round(score)));
    const threshold=app.kind==="grant"?(app.type==="genç"?60:65):60;
    const approved=score>=threshold;
    return {approved,score,threshold,profile:p,reason:approved?"Geri ödeme kapasitesi ve işletme skoru yeterli.":"İşletme skoru, nakit akışı veya borç yükü banka kriterlerini karşılamadı."};
}

function bankApplyLoan(type){
    const bank=ensureBankState();
    const cfg={
        işletme:{name:"İşletme Kredisi",max:50000,rate:0.12,months:12,grace:7,review:1},
        yatırım:{name:"Yatırım Kredisi",max:150000,rate:0.08,months:24,grace:14,review:2},
        hayvancılık:{name:"Hayvancılık Kredisi",max:100000,rate:0.06,months:18,grace:10,review:2}
    }[type];
    if(!cfg)return;
    if(bank.loanApplications.some(a=>a.type===type&&a.status==="İncelemede")){addLog("⚠ Bu kredi için başvurunuz zaten banka incelemesinde.");return;}
    const amount=Number(prompt(cfg.name+"\\nBaşvuru tutarı (₺):",Math.min(cfg.max,25000)));
    if(!Number.isFinite(amount)||amount<=0||amount>cfg.max){addLog("⚠ Geçersiz kredi başvuru tutarı.");return;}
    bank.loanApplications.push({
        id:"KRD-BASV-"+Date.now(),kind:"loan",type,name:cfg.name,amount,
        status:"İncelemede",applyDay:game.day,decisionDay:game.day+cfg.review,
        cfg
    });
    addNotification("Kredi Başvurusu Alındı",cfg.name+" başvurunuz banka uzmanına iletildi. Sonuç: "+cfg.review+" gün içinde.","info",true);
    render();saveGame();
}

function bankApproveLoanApplication(app){
    const bank=ensureBankState();
    const cfg=app.cfg||{};
    const total=Number(app.amount||0)*(1+Number(cfg.rate||0));
    const installment=total/(Number(cfg.months)||1);
    game.money+=Number(app.amount)||0;
    bank.loans.push({
        id:"KRD-"+Date.now(),name:app.name,principal:Number(app.amount)||0,total,
        remaining:total,installment,monthsLeft:Number(cfg.months)||1,
        graceDays:Number(cfg.grace)||0,nextPaymentDay:game.day+Number(cfg.grace||0),
        applicationId:app.id,creditScore:app.score
    });
    bank.totalBorrowed+=Number(app.amount)||0;
    recordAccounting("Gelir",app.name+" Kredi Kullanımı",Number(app.amount)||0);
}

function bankRepayLoan(index){
    const bank=ensureBankState();
    const loan=bank.loans[index]; if(!loan)return;
    const payment=Math.min(Number(loan.installment)||0,Number(loan.remaining)||0);
    if(game.money<payment){addLog("⚠ Kredi taksiti için kasada yeterli para yok.");return;}
    game.money-=payment; game.expenses+=payment;
    loan.remaining=Math.max(0,loan.remaining-payment);
    loan.monthsLeft=Math.max(0,(loan.monthsLeft||1)-1);
    loan.nextPaymentDay=game.day+30;
    bank.totalRepaid+=payment;
    recordAccounting("Gider",loan.name+" Taksit Ödemesi",payment);
    if(loan.remaining<=0.01) bank.loans.splice(index,1);
    render();saveGame();
}

function applyFarmGrant(type){
    const bank=ensureBankState();
    const cfg={
        genç:{name:"Genç Çiftçi Yatırım Hibesi",amount:30000,days:2},
        hayvancılık:{name:"Hayvancılık Modernizasyon Hibesi",amount:50000,days:3},
        mandıra:{name:"Süt İşleme ve Pazarlama Hibesi",amount:75000,days:4}
    }[type];
    if(!cfg)return;
    if(bank.grantApplications.some(a=>a.type===type&&a.status==="İncelemede")){addLog("⚠ Bu hibe için başvurunuz zaten komisyon değerlendirmesinde.");return;}
    bank.grantApplications.push({
        type,kind:"grant",status:"İncelemede",applyDay:game.day,decisionDay:game.day+cfg.days,
        amount:cfg.amount,name:cfg.name
    });
    addNotification("Hibe Başvurusu Alındı",cfg.name+" dosyanız hibe komisyonuna gönderildi. Karar: "+cfg.days+" gün içinde.","info",true);
    render();saveGame();
}

function processBankDay(){
    const bank=ensureBankState();

    bank.loanApplications.forEach(app=>{
        if(app.status!=="İncelemede"||game.day<app.decisionDay)return;
        const result=evaluateBankApplication(app);
        app.score=result.score;
        app.status=result.approved?"Onaylandı":"Reddedildi";
        app.decisionDay=game.day;
        if(result.approved){
            bankApproveLoanApplication(app);
            addNotification("Kredi Onaylandı","Banka uzmanı başvurunuzu onayladı. "+Number(app.amount).toLocaleString("tr-TR")+" ₺ hesabınıza aktarıldı. Skor: "+result.score+"/100.","success",true);
        }else{
            addNotification("Kredi Reddedildi","Banka başvurunuzu reddetti. Skor: "+result.score+"/100. Gerekçe: "+result.reason,"warning",true);
        }
    });

    bank.grantApplications.forEach(app=>{
        if(app.status!=="İncelemede"||game.day<app.decisionDay)return;
        const result=evaluateBankApplication(app);
        app.score=result.score;
        app.status=result.approved?"Onaylandı":"Reddedildi";
        app.decisionDay=game.day;
        if(result.approved){
            game.money+=Number(app.amount)||0;
            game.income+=Number(app.amount)||0;
            bank.totalGrantIncome+=Number(app.amount)||0;
            recordAccounting("Gelir",app.name,Number(app.amount)||0);
            addNotification("Hibe Onaylandı","Hibe komisyonu başvurunuzu onayladı. "+Number(app.amount).toLocaleString("tr-TR")+" ₺ hesabınıza aktarıldı. Proje skoru: "+result.score+"/100.","success",true);
        }else{
            addNotification("Hibe Reddedildi","Hibe komisyonu başvurunuzu reddetti. Proje skoru: "+result.score+"/100. Gerekçe: "+result.reason,"warning",true);
        }
    });

    bank.loans.forEach(loan=>{
        if(game.day>=loan.nextPaymentDay&&loan.remaining>0.01){
            loan.nextPaymentDay=game.day+30;
            addNotification("Kredi Taksiti",loan.name+" için "+Number(loan.installment).toLocaleString("tr-TR")+" ₺ ödeme zamanı geldi.","warning",true);
        }
    });

    bank.loanApplications=bank.loanApplications.slice(-20);
    bank.grantApplications=bank.grantApplications.slice(-20);
}
function recordAccounting(type,category,amount){

    game.accountingLedger=game.accountingLedger||[];

    game.accountingLedger.unshift({
        day:game.day,
        time:formatGameTime(),
        type:type,
        category:category,
        amount:amount
    });

    game.accountingLedger=game.accountingLedger.slice(0,30);

}


/* =========================================================
   SAAT
========================================================= */

function formatGameTime(){

    const hours =
        Math.floor(
            game.minute/
            60
        );


    const minutes =
        game.minute%
        60;


    return(

        String(hours)
        .padStart(2,"0")

        +

        ":"

        +

        String(minutes)
        .padStart(2,"0")

    );

}


/* =========================================================
   LOG
========================================================= */

function addLog(message){

    const time =
        new Date()
        .toLocaleTimeString(
            "tr-TR",
            {
                hour:"2-digit",
                minute:"2-digit",
                second:"2-digit"
            }
        );


    const logs =
        JSON.parse(
            localStorage.getItem(
                "ciftlikLogs"
            )||
            "[]"
        );


    logs.unshift(
        `${time} | ${message}`
    );


    logs.splice(40);


    localStorage.setItem(
        "ciftlikLogs",
        JSON.stringify(logs)
    );


    /* Kullanıcıya yönelik uyarılar artık sağ altta kısa bildirim olarak da görünür. */
    if(
        typeof message==="string" &&
        message.trim().startsWith("⚠")
    ){
        const cleanMessage=message.replace(/^⚠\s*/,"").trim();
        addNotification(
            "Uyarı",
            cleanMessage,
            "warning",
            true
        );
    }


    renderLogs();

}


/* =========================================================
   LOG RENDER
========================================================= */

function renderLogs(){

    const container =
        document.getElementById(
            "eventLog"
        );


    if(!container)
        return;


    const logs =
        JSON.parse(
            localStorage.getItem(
                "ciftlikLogs"
            )||
            "[]"
        );


    container.innerHTML =

        logs.map(
            log=>
                `<div class="log">
                    ${log}
                </div>`
        ).join("");

}


/* =========================================================
   RASYON RENDER
========================================================= */

function renderRation(){

    updateRationAnalysis();


    const r =
        game.ration;


    document.getElementById(
        "rationDM"
    ).textContent =
        `${r.totalDM.toFixed(1)} kg`;


    document.getElementById(
        "rationNDF"
    ).textContent =
        `${r.totalNDF.toFixed(1)}%`;


    document.getElementById(
        "rationStarch"
    ).textContent =
        `${r.starch.toFixed(1)}%`;


    document.getElementById(
        "rationCP"
    ).textContent =
        `${r.crudeProtein.toFixed(1)}%`;


    document.getElementById(
        "rationADF"
    ).textContent =
        `${r.ADF.toFixed(1)}%`;


    document.getElementById(
        "rationFNDF"
    ).textContent =
        `${r.forageNDF.toFixed(1)}%`;


    document.getElementById(
        "rationForage"
    ).textContent =
        `${r.forage.toFixed(1)}%`;


    document.getElementById(
        "rationNDFD"
    ).textContent =
        `${r.FNDFD.toFixed(1)}%`;


    /*
      Input değerlerini
      kayıt ile senkronize et.
    */

    const fields={

        feedCornSilage:
            "cornSilage",

        feedAlfalfa:
            "alfalfaHay",

        feedCornGrain:
            "cornGrain",

        feedBarley:
            "barley",

        feedSoybean:
            "soybeanMeal"

    };


    Object.entries(
        fields
    ).forEach(
        ([id,key])=>{

            const input =
                document.getElementById(
                    id
                );


            if(
                input &&
                document.activeElement!==input
            ){

                input.value =
                    game.ration.amounts[key];

            }

        }
    );


    /*
      Uyarı
    */

    const warnings =
        getRationWarnings();


    const warningBox =
        document.getElementById(
            "rationWarning"
        );


    warningBox.innerHTML =
        warnings.map(
            warning=>
                `<div class="mb-1">
                    ${warning}
                </div>`
        ).join("");


    /*
      Barlar
    */

    const starchBar =
        document.getElementById(
            "starchBar"
        );


    starchBar.style.width =
        `${Math.min(
            100,
            (
                r.starch/
                35
            )*
            100
        )}%`;


    document.getElementById(
        "starchStatus"
    ).textContent =
        `${r.starch.toFixed(1)}%`;


    const ndfBar =
        document.getElementById(
            "ndfBar"
        );


    ndfBar.style.width =
        `${Math.min(
            100,
            (
                r.totalNDF/
                45
            )*
            100
        )}%`;


    document.getElementById(
        "ndfStatus"
    ).textContent =
        `${r.totalNDF.toFixed(1)}%`;


    const fndfBar =
        document.getElementById(
            "fndfBar"
        );


    fndfBar.style.width =
        `${Math.min(
            100,
            (
                r.forageNDF/
                35
            )*
            100
        )}%`;


    document.getElementById(
        "fndfStatus"
    ).textContent =
        `${r.forageNDF.toFixed(1)}%`;

}


/* =========================================================
   SÜRÜ RENDER
========================================================= */

function renderHerd(){

    const container=document.getElementById("herdContainer");
    if(!container) return;

    const search=(document.getElementById("herdSearch")?.value||"").trim().toLocaleLowerCase("tr-TR");
    const filter=document.getElementById("herdFilter")?.value||"all";

    const getStatus=cow=>{
        if(cow.saraRisk>=50) return "sara";
        if(cow.health<80) return "health";
        if(cow.udderFill>=100) return "udder";
        return "normal";
    };

    const counts={
        normal:0,
        health:0,
        sara:0
    };

    game.cows.forEach(cow=>{
        const status=getStatus(cow);
        if(status==="normal") counts.normal++;
        if(status==="health") counts.health++;
        if(status==="sara") counts.sara++;
    });

    const setText=(id,value)=>{
        const el=document.getElementById(id);
        if(el) el.textContent=value;
    };

    setText("herdTotal",game.cows.length);
    setText("herdNormal",counts.normal);
    setText("herdHealth",counts.health);
    setText("herdSara",counts.sara);

    const visibleCows=game.cows.filter(cow=>{
        const status=getStatus(cow);
        const matchesFilter=
            filter==="all" ||
            (filter==="normal" && status==="normal") ||
            (filter==="health" && status==="health") ||
            (filter==="sara" && status==="sara") ||
            (filter==="udder" && cow.udderFill>=100);

        const name=(cow.name||"").toLocaleLowerCase("tr-TR");
        return matchesFilter && (!search || name.includes(search));
    });

    if(!visibleCows.length){
        container.innerHTML=`<div class="col-span-full metric text-center py-8 text-sm text-slate-500">
            Aramaya/filtreye uyan hayvan bulunamadı.
        </div>`;
        return;
    }

    container.innerHTML=visibleCows.map(cow=>{

        const status=getStatus(cow);
        let statusText="NORMAL";
        let statusClass="green";

        if(status==="sara"){
            statusText="RUMEN ASİDOZU RİSKİ";
            statusClass="red";
        }else if(status==="health"){
            statusText="SAĞLIK TAKİBİ";
            statusClass="yellow";
        }else if(status==="udder"){
            statusText="YÜKSEK MEME DOLULUĞU";
            statusClass="red";
        }

        return `
        <div class="cow">

            <div class="flex justify-between">
                <b>🐄 ${cow.name}</b>
                <span class="${statusClass}">●</span>
            </div>

            <div class="text-xs text-slate-500 mt-2">
                BW: ${cow.weight} kg
            </div>

            <div class="text-xs text-slate-500">
                Laktasyon: ${cow.lactationDay}. gün
            </div>

            <div class="mt-3">
                <div class="flex justify-between text-xs mb-1">
                    <span>Meme doluluğu</span>
                    <span>${cow.udderFill.toFixed(1)}%</span>
                </div>
                <div class="progress">
                    <div style="width:${Math.min(100,cow.udderFill)}%;background:${cow.udderFill>=100?'var(--red)':'var(--blue)'};"></div>
                </div>
            </div>

            <div class="mt-3 grid grid-cols-2 gap-2">
                <div class="metric">
                    <div class="text-xs text-slate-500">DMI</div>
                    <b>${calculateDMI(cow).toFixed(1)} kg</b>
                </div>

                <div class="metric">
                    <div class="text-xs text-slate-500">Süt</div>
                    <b class="green">${cow.milkYield.toFixed(1)} L</b>
                </div>

                <div class="metric">
                    <div class="text-xs text-slate-500">Rumen pH</div>
                    <b class="${cow.rumenPH<5.8?'red':'green'}">${cow.rumenPH.toFixed(2)}</b>
                </div>

                <div class="metric">
                    <div class="text-xs text-slate-500">Rumen Asidozu Riski</div>
                    <b class="${cow.saraRisk>=50?'red':'green'}">${cow.saraRisk.toFixed(0)}%</b>
                </div>

                <div class="metric">
                    <div class="text-xs text-slate-500">BCS</div>
                    <b>${cow.bcs.toFixed(2)}</b>
                </div>

                <div class="metric">
                    <div class="text-xs text-slate-500">Sağlık</div>
                    <b class="${cow.health<80?'red':'green'}">${cow.health.toFixed(1)}%</b>
                </div>
            </div>

            <div class="mt-3 text-xs ${statusClass}">
                ● ${statusText}
            </div>

            <button type="button" onclick="openAnimalCard('${String(cow.id).replace(/'/g,"\\'")}')" class="mt-3 w-full nav-btn text-blue-300 border-blue-500/20">
                📋 Hayvan Kartını Aç
            </button>

        </div>`;
    }).join("");
}


function getAnimalCardStatus(cow){
    if(cow.saraRisk>=50) return "Rumen asidozu riski";
    if(cow.health<80) return "Sağlık takibi";
    if(cow.udderFill>=100) return "Sağım kontrolü";
    return "Normal";
}

function formatAnimalBirthDate(value){
    if(!value) return "Kayıt yok";
    const d=new Date(value+"T00:00:00");
    if(Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("tr-TR");
}

function openAnimalCard(id){
    const cow=game.cows.find(item=>String(item.id)===String(id));
    if(!cow) return;
    cow.healthHistory=Array.isArray(cow.healthHistory)?cow.healthHistory:[];
    cow.reproduction={status:"Laktasyonda",heatDay:null,inseminationDay:null,pregnancyCheckDay:null,pregnant:false,expectedCalvingDay:null,lastCalvingDay:null,dryOffDay:null,...(cow.reproduction||{})};
    const modal=document.getElementById("animalCardModal");
    const title=document.getElementById("animalCardTitle");
    const status=document.getElementById("animalCardStatus");
    const grid=document.getElementById("animalCardGrid");
    if(!modal||!title||!status||!grid) return;
    title.textContent="🐄 "+(cow.name||("İnek "+cow.id));
    status.textContent=getAnimalCardStatus(cow);
    const r=cow.reproduction;
    const reproductionStatus=r.pregnant?"🤰 Gebe":(r.status||"Laktasyonda");
    const calfCare=cow.calfCare||{};
    const calfFields=cow.isCalf?[
        ["Hayvan Dönemi","🐮 Buzağı"],
        ["Yaş",(Number(cow.ageDays)||0)+" gün"],
        ["Anne",game.cows.find(m=>String(m.id)===String(cow.motherId))?.name||"Kayıtlı değil"],
        ["Kolostrum",calfCare.colostrumReceived?"Alındı":"Eksik"],
        ["Sütle Besleme",calfCare.weaned?"Tamamlandı":(Number(calfCare.milkFedDays)||0)+" gün"],
        ["Sütten Kesim",calfCare.weaned?"Tamamlandı":(calfCare.weaningDay?"Gün "+calfCare.weaningDay:"Planlanıyor")],
        ["Başlangıç Yemi",(Number(calfCare.starterFeedIntake)||0).toFixed(1)+" kg"],
        ["Canlı Ağırlık",(Number(cow.weight)||0).toFixed(0)+" kg"],
        ["Sağlık",(Number(cow.health)||0).toFixed(1)+"%"]
    ]:[];
    const fields=cow.isCalf?calfFields:[
        ["Küpe No",cow.earTag||("TR-"+String(cow.id).padStart(4,"0"))],["Irk",cow.breed||"Belirtilmemiş"],["Cinsiyet",cow.sex||"Dişi"],
        ["Doğum Tarihi",formatAnimalBirthDate(cow.birthDate)],["Laktasyon No",String(cow.lactationNumber||1)],["Laktasyon Günü",String(cow.lactationDay||0)],
        ["Canlı Ağırlık",(Number(cow.weight)||0).toFixed(0)+" kg"],["BCS",(Number(cow.bcs)||0).toFixed(2)],["Günlük Süt",(Number(cow.milkYield)||0).toFixed(1)+" L"],
        ["Sağlık",(Number(cow.health)||0).toFixed(1)+"%"],["Rumen pH",(Number(cow.rumenPH)||0).toFixed(2)],["SARA Riski",(Number(cow.saraRisk)||0).toFixed(0)+"%"],
        ["Hastalık Riski",(Number(cow.diseaseRisk)||0).toFixed(0)+"%"],["Meme Doluluğu",(Number(cow.udderFill)||0).toFixed(1)+"%"],
        ["Enerji Dengesi",(Number(cow.energyBalance)||0).toFixed(2)],["Üreme Durumu",reproductionStatus],
        ["Son Kızgınlık",r.heatDay?"Gün "+r.heatDay:"Kayıt yok"],["Tohumlama",r.inseminationDay?"Gün "+r.inseminationDay:"Kayıt yok"],
        ["Gebelik Kontrolü",r.pregnancyCheckDay?"Gün "+r.pregnancyCheckDay:"Yapılmadı"],["Tahmini Doğum",r.expectedCalvingDay?"Gün "+r.expectedCalvingDay:"Belirlenmedi"],
        ["Son Doğum",r.lastCalvingDay?"Gün "+r.lastCalvingDay:"Kayıt yok"],["Alım Tarihi",formatAnimalBirthDate(cow.purchaseDate)]
    ];
    const milkHistory=Array.isArray(cow.milkHistory)?cow.milkHistory:[];
    const milkValues=milkHistory.map(item=>Number(item.yield)||0);
    const milkLast=milkValues.length?milkValues[0]:0;
    const milkAvg=milkValues.length?milkValues.reduce((a,b)=>a+b,0)/milkValues.length:0;
    const milkRecent=milkValues.slice(0,6);
    const milkPrev=milkValues.slice(1,7);
    const milkPrevAvg=milkPrev.length?milkPrev.reduce((a,b)=>a+b,0)/milkPrev.length:0;
    const milkDropPct=milkPrevAvg>0?((milkPrevAvg-milkLast)/milkPrevAvg)*100:0;
    const milkBars=milkHistory.slice(0,8).reverse();
    const maxMilk=Math.max(1,...milkBars.map(item=>Number(item.yield)||0));
    const milkChart=milkBars.length
        ? '<div class="milk-history-chart">'+milkBars.map(item=>{
            const value=Math.max(0,Number(item.yield)||0);
            const height=Math.max(8,Math.round((value/maxMilk)*100));
            return '<div class="milk-chart-col"><div class="milk-chart-value">'+value.toFixed(1)+'</div><div class="milk-chart-track"><div class="milk-chart-bar" style="height:'+height+'%"></div></div><div class="milk-chart-label">G'+item.day+'<br>'+item.time+'</div></div>';
        }).join("")+'</div>'
        : '<div class="notification-empty">Henüz sağım geçmişi oluşmadı.</div>';

    grid.innerHTML=fields.map(([label,value])=>'<div class="animal-card-field"><div class="animal-card-field-label">'+label+'</div><div class="animal-card-field-value">'+value+'</div></div>').join("")+
    '<div class="animal-card-section"><div class="animal-card-section-title">🥛 Süt Verimi Geçmişi</div>'+
    '<div class="grid grid-cols-3 gap-2 mb-3">'+
    '<div class="metric"><div class="text-[9px] text-slate-500">SON SAĞIM</div><b class="green">'+milkLast.toFixed(1)+' L</b></div>'+
    '<div class="metric"><div class="text-[9px] text-slate-500">ORTALAMA</div><b>'+milkAvg.toFixed(1)+' L</b></div>'+
    '<div class="metric"><div class="text-[9px] text-slate-500">DEĞİŞİM</div><b class="'+(milkDropPct>=15?'red':'green')+'">'+(milkPrevAvg>0?(milkDropPct>=0?'-':'＋')+Math.abs(milkDropPct).toFixed(1)+'%':'—')+'</b></div>'+
    '</div>'+milkChart+
    '<div class="animal-card-history">'+(milkHistory.length?milkHistory.slice(0,8).map(item=>'<div><b>Gün '+item.day+' • '+item.time+'</b> — '+(Number(item.yield)||0).toFixed(1)+' L</div>').join(""):'')+'</div></div>'+
    '<div class="animal-card-section"><div class="animal-card-section-title">🩺 Sağlık & Veteriner</div><div class="animal-card-action-grid">'+
    '<button type="button" class="nav-btn" onclick="callVeterinarian(\''+String(cow.id)+'\')">👨‍⚕️ Veteriner Çağır</button>'+
    '<button type="button" class="nav-btn" onclick="recordAnimalHealth(\''+String(cow.id)+'\',\'Muayene\')">🩺 Muayene</button>'+
    '<button type="button" class="nav-btn" onclick="callVeterinarian(\''+String(cow.id)+'\')">👨‍⚕️ Veteriner Çağır</button>'+
    '<button type="button" class="nav-btn" onclick="recordAnimalHealth(\''+String(cow.id)+'\',\'Aşılama\')">💉 Aşılama</button></div>'+
    '<div class="text-[10px] text-slate-500 mt-2">Veteriner çağrısı nakit yoksa veresiye açılabilir. Borç Muhasebe → İşlemler bölümünden kapatılır.</div>'+
    '<div class="animal-card-history">'+(cow.healthHistory.length?cow.healthHistory.slice(0,5).map(item=>'<div><b>Gün '+item.day+'</b> • '+item.type+(item.note?" — "+item.note:"")+'</div>').join(""):'<div class="text-slate-500">Henüz sağlık kaydı yok.</div>')+'</div></div>'+
    (cow.isCalf?
    '<div class="animal-card-section"><div class="animal-card-section-title">🍼 Buzağı Bakımı</div><div class="animal-card-history">'+
    '<div>Kolostrum: <b>'+(calfCare.colostrumReceived?"Alındı":"Eksik")+'</b></div>'+
    '<div>Sütle besleme: <b>'+(calfCare.weaned?"Tamamlandı":(Number(calfCare.milkFedDays)||0)+" gün")+'</b></div>'+
    '<div>Sütten kesim: <b>'+(calfCare.weaned?"Tamamlandı":(calfCare.weaningDay?"Gün "+calfCare.weaningDay:"Planlanıyor"))+'</b></div>'+
    '<div>Başlangıç yemi: <b>'+(Number(calfCare.starterFeedIntake)||0).toFixed(1)+' kg</b></div>'+
    '</div></div>':
    '<div class="animal-card-section"><div class="animal-card-section-title">♀️ Üreme Yönetimi</div><div class="animal-card-action-grid">'+
    '<button type="button" class="nav-btn" onclick="recordHeat(\''+String(cow.id)+'\')">🔥 Kızgınlık</button>'+
    '<button type="button" class="nav-btn" onclick="recordInsemination(\''+String(cow.id)+'\')">🧬 Tohumlama</button>'+
    '<button type="button" class="nav-btn" onclick="checkPregnancy(\''+String(cow.id)+'\')">🤰 Gebelik Kontrolü</button>'+
    '<button type="button" class="nav-btn" onclick="recordCalving(\''+String(cow.id)+'\')">🐮 Doğum</button>'+
    '<button type="button" class="nav-btn" onclick="recordDryOff(\''+String(cow.id)+'\')">🌙 Kuruya Çıkarma</button></div></div>');
    modal.classList.add("open");
    modal.setAttribute("aria-hidden","false");
}

function refreshAnimalCard(id){openAnimalCard(id);render();saveGame();}
function getCowById(id){return game.cows.find(item=>String(item.id)===String(id));}
function addAnimalHealthRecord(cow,type,note=""){
    cow.healthHistory=Array.isArray(cow.healthHistory)?cow.healthHistory:[];
    cow.healthHistory.unshift({day:game.day,time:formatGameTime(),type,note});
    cow.healthHistory=cow.healthHistory.slice(0,30);
}
function getVeterinaryOutstanding(){
    game.veterinary=game.veterinary||{invoices:[],totalInvoiced:0,totalPaid:0,maxOutstanding:20000};
    game.veterinary.invoices=Array.isArray(game.veterinary.invoices)?game.veterinary.invoices:[];
    return game.veterinary.invoices
        .filter(item=>item.status==="Açık")
        .reduce((sum,item)=>sum+(Number(item.amount)||0),0);
}

function diagnoseCowForVet(cow){
    const reasons=[];
    const expected=Math.max(1,Number(cow.milkPotential)||30);
    const current=Math.max(0,Number(cow.milkYield)||0);
    if(cow.reproduction?.status==="Kuru Dönem"){
        return {title:"Kuru dönem",reason:"Hayvan kuru dönemde; sağım beklenmez.",action:"Sağım yapılmaz."};
    }
    if(current < expected*0.45) reasons.push("Süt verimi beklenen düzeyin belirgin altında");
    if((Number(cow.health)||0)<85) reasons.push("genel sağlık düşüklüğü");
    if((Number(cow.saraRisk)||0)>=50) reasons.push("SARA / rumen pH problemi");
    if((Number(cow.bcs)||0)<2.6) reasons.push("düşük kondisyon ve enerji açığı");
    if((Number(cow.diseaseRisk)||0)>=40) reasons.push("yüksek hastalık riski");
    if((Number(cow.udderFill)||0)<20) reasons.push("meme doluluğu düşük; sağım zamanlaması kontrol edilmeli");
    if(!reasons.length) reasons.push("belirgin klinik sorun saptanmadı; sağım programı ve rasyon kontrolü önerilir");
    return {
        title: current < expected*0.45 ? "Düşük süt verimi" : "Kontrol gerekli",
        reason: reasons.join(", ")+".",
        action: current < expected*0.45 ? "Muayene + hedefli tedavi / rasyon düzeltmesi" : "İzlem ve rutin muayene"
    };
}

function callVeterinarian(id){
    const cow=getCowById(id); if(!cow || cow.isCalf) return;
    game.veterinary=game.veterinary||{invoices:[],totalInvoiced:0,totalPaid:0,maxOutstanding:20000};
    const outstanding=getVeterinaryOutstanding();
    const diagnosis=diagnoseCowForVet(cow);

    if(diagnosis.title==="Kuru dönem"){
        addNotification("Veteriner Değerlendirmesi",cow.name+" kuru dönemde. Sağım düşüklüğü hastalık olarak değerlendirilmedi.","info",true);
        refreshAnimalCard(id);
        return;
    }

    const base=1200;
    const treatment=(Number(cow.health)<85 || Number(cow.saraRisk)>=50 || Number(cow.diseaseRisk)>=40 || Number(cow.bcs)<2.6) ? 1800 : 0;
    const amount=base+treatment;

    if(outstanding+amount>Number(game.veterinary.maxOutstanding||20000)){
        addLog("⚠ Veteriner veresiye limiti dolu. Önce mevcut faturaların bir kısmını öde.");
        addNotification("Veteriner Kredisi Doldu","Açık veteriner faturaları "+outstanding.toLocaleString("tr-TR")+" ₺. Önce borcu azalt.","warning",true);
        return;
    }

    const invoice={
        id:"VET-"+Date.now()+"-"+String(cow.id),
        cowId:cow.id,
        cowName:cow.name,
        day:game.day,
        dueDay:game.day+3,
        amount,
        status:"Açık",
        diagnosis:diagnosis.reason,
        action:diagnosis.action
    };

    game.veterinary.invoices.unshift(invoice);
    game.veterinary.totalInvoiced=(Number(game.veterinary.totalInvoiced)||0)+amount;

    // Hizmet alınmış sayılır: gider hemen oluşur, nakit ise ödeme gününe kadar değişmez.
    game.expenses+=amount;
    recordAccounting("Gider","Veterinerlik - Veresiye",amount);

    // Hedefe yönelik klinik müdahale.
    cow.health=Math.min(100,(Number(cow.health)||0)+10);
    cow.diseaseRisk=Math.max(0,(Number(cow.diseaseRisk)||0)-30);
    cow.saraRisk=Math.max(0,(Number(cow.saraRisk)||0)-35);
    cow.rumenPH=Math.min(6.6,(Number(cow.rumenPH)||6.0)+0.18);
    cow.bcs=Math.min(4.5,(Number(cow.bcs)||2.8)+0.08);
    cow.milkYield=calculateMilkProduction(cow);
    addAnimalHealthRecord(cow,"Veteriner","Muayene: "+diagnosis.reason+" | Plan: "+diagnosis.action+" | Fatura: "+amount.toLocaleString("tr-TR")+" ₺ veresiye");

    addNotification(
        "Veteriner Çiftliğe Geldi",
        cow.name+" muayene edildi. "+diagnosis.reason+" Borç: "+amount.toLocaleString("tr-TR")+" ₺ • vade: Gün "+invoice.dueDay,
        "success",
        true
    );
    addLog("👨‍⚕️ Veteriner hizmeti: "+cow.name+" • "+amount.toLocaleString("tr-TR")+" ₺ veresiye.");
    refreshAnimalCard(id);
}

function payVeterinaryInvoice(invoiceId){
    game.veterinary=game.veterinary||{invoices:[]};
    const invoice=game.veterinary.invoices.find(item=>item.id===invoiceId);
    if(!invoice || invoice.status!=="Açık") return;
    const amount=Number(invoice.amount)||0;
    if((Number(game.money)||0)<amount){
        addLog("⚠ Veteriner borcunu ödemek için yeterli nakit yok.");
        addNotification("Ödeme Yapılamadı","Veteriner faturası için "+amount.toLocaleString("tr-TR")+" ₺ nakit gerekiyor.","warning",true);
        return;
    }
    game.money-=amount;
    invoice.status="Ödendi";
    invoice.paidDay=game.day;
    game.veterinary.totalPaid=(Number(game.veterinary.totalPaid)||0)+amount;
    recordAccounting("Gider Ödemesi","Veteriner Veresiye Ödemesi",amount);
    addNotification("Veteriner Borcu Ödendi",invoice.cowName+" için "+amount.toLocaleString("tr-TR")+" ₺ ödeme yapıldı.","success",true);
    render();
    saveGame();
}

function renderVeterinaryPayables(){
    const outstandingEl=document.getElementById("veterinaryOutstanding");
    const listEl=document.getElementById("veterinaryInvoiceList");
    if(!outstandingEl||!listEl) return;
    const invoices=(game.veterinary?.invoices||[]).filter(item=>item.status==="Açık");
    const outstanding=invoices.reduce((sum,item)=>sum+(Number(item.amount)||0),0);
    outstandingEl.textContent=outstanding.toLocaleString("tr-TR")+" ₺";
    listEl.innerHTML=invoices.length?invoices.slice(0,8).map(item=>{
        const overdue=Number(game.day)>Number(item.dueDay);
        return '<div class="flex items-center justify-between gap-3 p-2 rounded-xl border border-slate-800 bg-slate-950/30">'+
            '<div class="min-w-0"><b class="text-xs">'+item.cowName+'</b><div class="text-[9px] text-slate-500">'+item.amount.toLocaleString("tr-TR")+' ₺ • '+(overdue?'Vadesi geçti':'Vade Gün '+item.dueDay)+'</div></div>'+
            '<button class="nav-btn text-green-300 text-xs" onclick="payVeterinaryInvoice(\''+item.id+'\')">Öde</button></div>';
    }).join(""):'<div class="text-[10px] text-slate-500">Açık veteriner faturası yok.</div>';
}

function ensureVetState(){
    game.veterinary=game.veterinary||{debts:[],totalDebt:0,totalPaid:0};
    game.veterinary.debts=Array.isArray(game.veterinary.debts)?game.veterinary.debts:[];
    game.veterinary.totalDebt=Number(game.veterinary.totalDebt)||0;
    game.veterinary.totalPaid=Number(game.veterinary.totalPaid)||0;
}
function getVeterinaryDiagnosis(cow){
    const issues=[];
    if(Number(cow.health)<75) issues.push("Genel sağlık düşüklüğü");
    if(Number(cow.diseaseRisk)>=35) issues.push("Hastalık riski yüksek");
    if(Number(cow.saraRisk)>=35 || Number(cow.rumenPH)<5.8) issues.push("Rumen/SARA problemi");
    if(Number(cow.bcs)<2.7) issues.push("Vücut kondisyonu düşük");
    if(Number(cow.udderFill)<35) issues.push("Meme doluluğu düşük; sağım zamanı dışında");
    if(!issues.length) issues.push("Belirgin klinik sorun saptanmadı");
    const expected=Math.max(0,Number(cow.milkPotential)||0);
    const actual=Math.max(0,Number(cow.milkYield)||0);
    if(expected>0 && actual<expected*0.55) issues.push("Süt verimi potansiyelin belirgin altında");
    return issues;
}
function callVeterinarian(id){
    const cow=getCowById(id); if(!cow || cow.isCalf) return;
    ensureVetState();
    const fee=1500;
    const creditDays=15;
    const dueDay=game.day+creditDays;
    const diagnosis=getVeterinaryDiagnosis(cow);
    const debt={id:"VET-"+Date.now(),day:game.day,dueDay,animalId:cow.id,animalName:cow.name,amount:fee,status:"Veresiye"};
    game.veterinary.debts.unshift(debt);
    game.veterinary.totalDebt+=fee;
    game.expenses+=fee;
    recordAccounting("Gider","Veteriner Hizmeti (Veresiye)",fee);
    addAnimalHealthRecord(cow,"Veteriner Muayenesi","Sorunlar: "+diagnosis.join(", ")+" | 15 gün veresiye");
    const severe=diagnosis.some(x=>x.includes("Süt verimi")||x.includes("Hastalık")||x.includes("SARA"));
    if(severe){
        cow.health=Math.min(100,(Number(cow.health)||0)+3);
        cow.diseaseRisk=Math.max(0,(Number(cow.diseaseRisk)||0)-5);
    }
    addNotification("Veteriner Geldi","👨‍⚕️ "+cow.name+" muayene edildi. Ücret "+fee.toLocaleString("tr-TR")+" ₺, ödeme "+creditDays+" gün sonra. "+diagnosis.join(" • "),"warning",true);
    addLog("👨‍⚕️ Veteriner: "+cow.name+" | "+diagnosis.join(" • ")+" | "+fee.toLocaleString("tr-TR")+" ₺ veresiye");
    refreshAnimalCard(id);
}
function processVeterinaryDebts(){
    ensureVetState();
    for(const debt of game.veterinary.debts){
        if(debt.status==="Veresiye" && game.day>=Number(debt.dueDay)){
            if(game.money>=Number(debt.amount)){
                game.money-=Number(debt.amount);
                debt.status="Ödendi";
                game.veterinary.totalDebt=Math.max(0,game.veterinary.totalDebt-Number(debt.amount));
                game.veterinary.totalPaid+=Number(debt.amount);
                addLog("💳 Veteriner veresiye borcu ödendi: "+debt.amount.toLocaleString("tr-TR")+" ₺");
                addNotification("Veteriner Borcu Ödendi",debt.animalName+" için "+debt.amount.toLocaleString("tr-TR")+" ₺ ödeme yapıldı.","info",true);
            }else{
                addNotification("Veteriner Borcu","⚠ "+debt.animalName+" için "+Number(debt.amount).toLocaleString("tr-TR")+" ₺ veteriner borcu vadesi geldi ancak kasada yeterli para yok.","warning",true);
            }
        }
    }
}
function recordAnimalHealth(id,type){
    const cow=getCowById(id);if(!cow)return;
    let note="";
    if(type==="Muayene"){
        note=prompt("Muayene notu (opsiyonel):","Genel klinik muayene");if(note===null)return;
        addAnimalHealthRecord(cow,"Muayene",note);
        addNotification("Veteriner Kaydı",cow.name+": muayene kaydı oluşturuldu.","info",true);
    }else if(type==="Tedavi"){
        note=prompt("Tanı / uygulanan tedavi:","");if(!note)return;
        const cost=Number(prompt("Tedavi maliyeti (₺):","750"));
        if(Number.isFinite(cost)&&cost>0){if(game.money<cost){addLog("⚠ Tedavi için yeterli nakit yok.");return;}game.money-=cost;game.expenses+=cost;recordAccounting("Gider","Veterinerlik - Tedavi",cost);}
        cow.health=Math.min(100,cow.health+8);addAnimalHealthRecord(cow,"Tedavi",note);
        addNotification("Tedavi Kaydı",cow.name+": "+note+" kaydedildi. Sağlık "+cow.health.toFixed(0)+"%.","success",true);
    }else{
        note=prompt("Aşı adı / uygulama notu:","");if(!note)return;
        const cost=300;if(game.money<cost){addLog("⚠ Aşılama için yeterli nakit yok.");return;}
        game.money-=cost;game.expenses+=cost;recordAccounting("Gider","Veterinerlik - Aşılama",cost);
        addAnimalHealthRecord(cow,"Aşılama",note);addNotification("Aşılama Kaydı",cow.name+": "+note+" aşısı kaydedildi.","success",true);
    }
    refreshAnimalCard(id);
}
function recordHeat(id){
    const cow=getCowById(id);if(!cow)return;
    const r=cow.reproduction||{};
    if(r.pregnant){
        addLog("⚠ "+cow.name+" gebe olduğu için kızgınlık kaydı oluşturulamaz.");
        return;
    }
    if(r.status==="Kuru Dönem"){
        addLog("⚠ "+cow.name+" kuru dönemde. Önce laktasyon/doğum durumunu güncelle.");
        return;
    }
    r.status="Kızgınlık";r.heatDay=game.day;r.inseminationDay=null;r.pregnancyCheckDay=null;r.pregnant=false;r.expectedCalvingDay=null;r.nextHeatDay=null;
    addAnimalHealthRecord(cow,"Üreme","Kızgınlık tespit edildi");
    addNotification("Kızgınlık Tespit Edildi",cow.name+" için kızgınlık kaydı oluşturuldu. Tohumlama planlanabilir.","warning",true);refreshAnimalCard(id);
}
function recordInsemination(id){
    const cow=getCowById(id);if(!cow)return;const r=cow.reproduction||{};
    if(r.pregnant){addLog("⚠ "+cow.name+" zaten gebe.");return;}
    if(r.status==="Kuru Dönem"){addLog("⚠ "+cow.name+" kuru dönemde tohumlanamaz.");return;}
    if(r.status!=="Kızgınlık"&&!r.heatDay){addLog("⚠ "+cow.name+" için önce kızgınlık kaydı oluşturulmalı.");return;}
    r.status="Tohumlandı";r.inseminationDay=game.day;r.pregnancyCheckDay=game.day+28;r.pregnant=false;r.expectedCalvingDay=game.day+REPRODUCTION_CONFIG.gestationDays;r.nextHeatDay=null;cow.reproduction=r;
    addAnimalHealthRecord(cow,"Üreme","Tohumlama yapıldı; gebelik kontrolü 28 gün sonra planlandı");
    addNotification("Tohumlama Kaydı",cow.name+" tohumlandı. Gebelik kontrolü yaklaşık Gün "+r.pregnancyCheckDay+".","info",true);refreshAnimalCard(id);
}
function checkPregnancy(id){
    const cow=getCowById(id);if(!cow)return;const r=cow.reproduction||{};
    if(!r.inseminationDay){addLog("⚠ "+cow.name+" için kayıtlı tohumlama bulunmuyor.");return;}
    if(game.day<r.inseminationDay+28){addLog("⚠ Gebelik kontrolü için henüz erken. Önerilen gün: "+(r.inseminationDay+28)+".");return;}
    const positive=confirm(cow.name+" için gebelik testi pozitif mi?\n\nTamam = Pozitif, İptal = Negatif");
    r.pregnancyCheckDay=game.day;r.pregnant=positive;r.status=positive?"Gebe":"Tekrar tohumlama bekleniyor";
    if(!positive){
        r.inseminationDay=null;
        r.expectedCalvingDay=null;
        r.pregnant=false;
        r.status="Laktasyonda";
        r.nextHeatDay=game.day+getNextEstrousCycleDays();
    }else{
        r.nextHeatDay=null;
        r.status="Gebe";
    }
    cow.reproduction=r;
    addAnimalHealthRecord(cow,"Üreme",positive?"Gebelik kontrolü pozitif":"Gebelik kontrolü negatif");
    addNotification(positive?"Gebelik Pozitif":"Gebelik Negatif",positive?cow.name+" gebelik açısından pozitif. Tahmini doğum Gün "+r.expectedCalvingDay+".":cow.name+" gebelik açısından negatif. Yeni kızgınlık/tohumlama planlanmalı.",positive?"success":"warning",true);refreshAnimalCard(id);
}
function createCalf(mother){
    const nextId=game.cows.reduce((max,c)=>Math.max(max,Number(c.id)||0),0)+1;
    const male=Math.random()<0.5;
    return {
        id:nextId,
        name:"Buzağı "+nextId,
        earTag:"TR-"+String(nextId).padStart(4,"0"),
        breed:mother.breed||"Holstein",
        sex:male?"Erkek":"Dişi",
        birthDate:"Gün "+game.day,
        purchaseDate:"",
        ageDays:0,
        isCalf:true,
        motherId:mother.id,
        weight:male?42:38,
        lactationDay:0,
        lactationNumber:0,
        milkPotential:0,
        milkYield:0,
        udderFill:0,
        bcs:2.8,
        health:100,
        rumenPH:6.2,
        saraRisk:0,
        energyBalance:0,
        diseaseRisk:0,
        healthHistory:[],
        milkHistory:[],
        reproduction:{
            status:"Buzağı",
            heatDay:null,
            inseminationDay:null,
            pregnancyCheckDay:null,
            pregnant:false,
            expectedCalvingDay:null,
            lastCalvingDay:null,
            dryOffDay:null,
            nextHeatDay:null
        },
        calfCare:{
            colostrumReceived:true,
            milkFedDays:0,
            weaningDay:null,
            weaned:false,
            starterFeedIntake:0,
            lastCareDay:null
        }
    };
}

function recordCalving(id){
    const cow=getCowById(id);if(!cow)return;const r=cow.reproduction||{};
    if(!r.pregnant){addLog("⚠ "+cow.name+" kayıtlı gebe değil. Doğum kaydı için önce gebelik durumunu doğrula.");return;}
    r.status="Doğum Sonrası";r.lastCalvingDay=game.day;r.pregnant=false;r.expectedCalvingDay=null;r.inseminationDay=null;r.pregnancyCheckDay=null;r.heatDay=null;r.dryOffDay=null;r.nextHeatDay=game.day+REPRODUCTION_CONFIG.voluntaryWaitingDays;
    cow.lactationNumber=(cow.lactationNumber||1)+1;cow.lactationDay=1;cow.udderFill=0;cow.reproduction=r;

    const calf=createCalf(cow);
    game.cows.push(calf);

    addAnimalHealthRecord(cow,"Üreme","Doğum kaydı oluşturuldu; "+calf.name+" sürüye katıldı");
    addAnimalHealthRecord(calf,"Doğum",""+cow.name+" tarafından doğdu");
    addNotification(
        "Doğum ve Buzağı",
        cow.name+" doğum yaptı. "+calf.name+" ("+calf.sex+") sürüye katıldı.",
        "success",
        true
    );
    refreshAnimalCard(id);
}
function recordDryOff(id){
    const cow=getCowById(id);if(!cow)return;const r=cow.reproduction||{};
    if(r.status==="Kuru Dönem"){addLog("⚠ "+cow.name+" zaten kuru dönemde.");return;}
    if(!r.pregnant){addLog("⚠ Kuruya çıkarma için hayvanın gebe olması gerekiyor.");return;}
    const daysToCalving=(Number(r.expectedCalvingDay)||0)-game.day;
    if(daysToCalving>REPRODUCTION_CONFIG.dryPeriodTargetDays+14){
        addLog("⚠ "+cow.name+" için kuruya çıkarma henüz erken. Tahmini doğuma yaklaşık "+daysToCalving+" gün var.");
        return;
    }
    if(daysToCalving<0){addLog("⚠ Tahmini doğum tarihi geçmiş. Önce doğum kaydını kontrol et.");return;}
    r.status="Kuru Dönem";r.dryOffDay=game.day;cow.milkYield=0;cow.udderFill=0;cow.reproduction=r;
    addAnimalHealthRecord(cow,"Üreme","Kuruya çıkarma kaydı");
    addNotification("Kuruya Çıkarma",cow.name+" kuru döneme alındı. Sağım durduruldu.","info",true);refreshAnimalCard(id);
}

function closeAnimalCard(){
    const modal=document.getElementById("animalCardModal");
    if(!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden","true");
}

function setupAnimalCardModal(){
    const modal=document.getElementById("animalCardModal");
    if(!modal) return;
    modal.addEventListener("click",event=>{
        if(event.target===modal) closeAnimalCard();
    });
    document.addEventListener("keydown",event=>{
        if(event.key==="Escape") closeAnimalCard();
    });
}

function updateFarmAtmosphere(){
    const layer=document.getElementById("farmAtmosphere");
    const chip=document.getElementById("weatherChip");
    const m=game.minute;
    const h=m/60;

    let sky="rgba(5,10,16,.28)";
    let icon="🌙";
    let weather="Gece";
    let temp=12;

    if(h>=6 && h<9){
        sky="rgba(255,177,80,.07)"; icon="🌅"; weather="Sabah"; temp=16;
    }else if(h>=9 && h<17){
        sky="rgba(82,180,255,.045)"; icon="☀️"; weather="Açık"; temp=22;
    }else if(h>=17 && h<20){
        sky="rgba(255,135,72,.09)"; icon="🌇"; weather="Akşam"; temp=19;
    }else{
        sky="rgba(20,35,75,.12)"; icon="🌙"; weather="Gece"; temp=13;
    }

    /* Hafif simülasyon havası: günlere göre değişen bulutlu/açık durum */
    const weatherCycle=game.day%5;
    if(weatherCycle===0){icon=h>=6&&h<20?"⛅":"☁️";weather="Parçalı bulutlu";temp-=2;}
    if(weatherCycle===1 && h>=10 && h<18){icon="☀️";weather="Açık";temp+=2;}
    if(weatherCycle===2){icon="🌤️";weather="Serin";temp-=1;}

    layer.style.background=sky;
    layer.style.opacity=h>=6&&h<20?"0.85":"0.65";

    if(chip) chip.textContent=`${icon} ${weather} • ${temp}°C`;
}

/* =========================================================
   ANA RENDER
========================================================= */

function animateDashboardNumber(id,target,formatter){
    const el=document.getElementById(id);
    if(!el) return;
    const value=Number(target)||0;
    el.dataset.numericValue=String(value);
    el.textContent=formatter(value);
}
function addNotification(title,text,type="info",showToast=true){
    if(!game.messages) game.messages=[];
    const notification={
        id:Date.now()+Math.random(),
        day:game.day,
        time:formatGameTime(),
        title,
        text,
        type
    };
    game.messages.unshift(notification);
    game.messages=game.messages.slice(0,30);
    renderNotifications();
    if(showToast) showNotificationToast(notification);
}

let notificationToastTimer=null;

function showNotificationToast(notification){
    const toast=document.getElementById("notificationToast");
    const icon=document.getElementById("notificationToastIcon");
    const title=document.getElementById("notificationToastTitle");
    const text=document.getElementById("notificationToastText");
    if(!toast||!icon||!title||!text) return;

    const icons={success:"✅",warning:"⚠️",danger:"🚨",info:"🔔"};
    icon.textContent=icons[notification.type]||icons.info;
    title.textContent=notification.title;
    text.textContent=notification.text;

    toast.classList.remove("hidden","hide");
    clearTimeout(notificationToastTimer);
    notificationToastTimer=setTimeout(()=>{
        toast.classList.add("hide");
        setTimeout(()=>toast.classList.add("hidden"),520);
    },4200);
}

function renderNotifications(){
    const list=document.getElementById("notificationList");
    const badge=document.getElementById("notificationBadge");
    const countText=document.getElementById("notificationCountText");
    if(!list||!badge||!countText) return;

    const messages=Array.isArray(game.messages)?game.messages:[];
    badge.textContent=messages.length>99?"99+":String(messages.length);
    badge.classList.toggle("hidden",messages.length===0);
    countText.textContent=messages.length
        ? messages.length+" kayıtlı bildirim"
        : "Yeni bildirim yok";

    if(!messages.length){
        list.innerHTML='<div class="notification-empty">📭 Henüz bildirim yok.</div>';
        return;
    }

    list.innerHTML=messages.map(msg=>
        '<div class="notification-item">'+
            '<div class="notification-item-title">'+(msg.title||"Bildirim")+'</div>'+
            '<div class="notification-item-meta">Gün '+(msg.day||game.day)+' • '+(msg.time||"--:--")+'</div>'+
            '<div class="notification-item-text">'+(msg.text||"")+'</div>'+
        '</div>'
    ).join("");
}

function setupNotifications(){
    const button=document.getElementById("notificationButton");
    const panel=document.getElementById("notificationPanel");
    const clear=document.getElementById("clearNotifications");
    if(!button||!panel||!clear) return;

    button.addEventListener("click",()=>{
        const opening=panel.classList.contains("hidden");
        panel.classList.toggle("hidden",!opening);
        panel.setAttribute("aria-hidden",String(!opening));
        button.setAttribute("aria-expanded",String(opening));
        if(opening) renderNotifications();
    });

    clear.addEventListener("click",()=>{
        game.messages=[];
        renderNotifications();
        saveGame();
    });

    document.addEventListener("pointerdown",event=>{
        if(panel.classList.contains("hidden")) return;
        if(panel.contains(event.target)||button.contains(event.target)) return;
        panel.classList.add("hidden");
        panel.setAttribute("aria-hidden","true");
        button.setAttribute("aria-expanded","false");
    });

    renderNotifications();
}

function checkSmartNotifications(){
    if(!game.cows?.length) return;
    game.notificationState=game.notificationState||{lowFeed:false,criticalFeed:false,health:{},sara:{},udder:{},milkDrop:{},reproduction:{}};
    game.notificationState.milkDrop=game.notificationState.milkDrop||{};
    game.notificationState.reproduction=game.notificationState.reproduction||{};
    const s=game.notificationState, feed=Number(game.feed||0);

    if(feed<200){
        if(!s.criticalFeed) addNotification("Yem Stoğu Kritik",`Yem stoğu ${Math.round(feed).toLocaleString("tr-TR")} kg seviyesine düştü. Yeni yem alımı gerekiyor.`,"danger",true);
        s.criticalFeed=true; s.lowFeed=true;
    }else if(feed<500){
        if(!s.lowFeed) addNotification("Yem Stoğu Azalıyor",`Yem stoğu ${Math.round(feed).toLocaleString("tr-TR")} kg. Yem alımını planlaman iyi olur.`,"warning",true);
        s.lowFeed=true; s.criticalFeed=false;
    }else{s.lowFeed=false;s.criticalFeed=false;}

    const activeIds=new Set();
    game.cows.forEach(cow=>{
        const id=String(cow.id); activeIds.add(id);
        const health=Number(cow.health??100), risk=Number(cow.diseaseRisk??0), sara=Number(cow.saraRisk??0), udder=Number(cow.udderFill??0);
        const h=s.health[id]||{low:false,critical:false,disease:false};
        if(health<60){
            if(!h.critical) addNotification("Hayvan Sağlığı Kritik",`İnek ${id} sağlık seviyesi ${health.toFixed(0)}%. Yakından kontrol edilmeli.`,"danger",true);
            h.critical=true;h.low=true;
        }else if(health<80){
            if(!h.low) addNotification("Hayvan Sağlığı Uyarısı",`İnek ${id} sağlık seviyesi ${health.toFixed(0)}%. Hayvanı takip et.`,"warning",true);
            h.low=true;h.critical=false;
        }else{h.low=false;h.critical=false;}
        if(risk>=70){
            if(!h.disease) addNotification("Hastalık Riski Yüksek",`İnek ${id} için hastalık riski ${risk.toFixed(0)}%. Kontrol önerilir.`,"danger",true);
            h.disease=true;
        }else h.disease=false;
        if(sara>=50 && !s.sara[id]){
            addNotification("SARA Riski",`İnek ${id} için rumen asidozu (SARA) riski yükseldi: ${sara.toFixed(0)}%.`,"warning",true);s.sara[id]=true;
        }else if(sara<35)s.sara[id]=false;
        if(udder>=100 && !s.udder[id]){
            addNotification("Sağım Uyarısı",`İnek ${id} meme doluluğu yüksek. Planlı sağımı kontrol et.`,"warning",true);s.udder[id]=true;
        }else if(udder<80)s.udder[id]=false;

        const milkHistory=Array.isArray(cow.milkHistory)?cow.milkHistory:[];
        if(milkHistory.length>=4){
            const latest=Number(milkHistory[0].yield)||0;
            const previous=milkHistory.slice(1,7).map(item=>Number(item.yield)||0).filter(value=>value>0);
            const previousAvg=previous.length?previous.reduce((sum,value)=>sum+value,0)/previous.length:0;
            const dropPct=previousAvg>0?((previousAvg-latest)/previousAvg)*100:0;
            const dropState=s.milkDrop[id]||false;
            if(dropPct>=15){
                if(!dropState){
                    addNotification("Süt Verimi Düşüşü",`İnek ${id} son sağımda önceki sağım ortalamasına göre %${dropPct.toFixed(0)} daha az süt verdi. Hayvanı ve sağım/yem koşullarını kontrol et.`,"warning",true);
                }
                s.milkDrop[id]=true;
            }else if(dropPct<8){
                s.milkDrop[id]=false;
            }
        }else{
            s.milkDrop[id]=false;
        }

        const reproduction=cow.reproduction||{};
        const reproductionState=s.reproduction[id]||{pregCheck:false,calving:false};
        const pregnancyDay=Number(reproduction.pregnancyCheckDay)||0;
        const calvingDay=Number(reproduction.expectedCalvingDay)||0;

        if(reproduction.inseminationDay && !reproduction.pregnant && pregnancyDay>0){
            const daysUntilCheck=pregnancyDay-game.day;
            if(daysUntilCheck<=0){
                if(!reproductionState.pregCheck){
                    addNotification("Gebelik Kontrolü Gecikti",cow.name+" için gebelik kontrolü yapılması gereken tarih geçti. Hayvanı kontrol et.","warning",true);
                }
                reproductionState.pregCheck=true;
            }else if(daysUntilCheck<=3 && !reproductionState.pregCheck){
                addNotification("Gebelik Kontrolü Yaklaşıyor",cow.name+" için gebelik kontrolüne yaklaşık "+daysUntilCheck+" gün kaldı.","info",true);
                reproductionState.pregCheck=true;
            }
        }else if(!reproduction.inseminationDay){
            reproductionState.pregCheck=false;
        }

        if(reproduction.pregnant && calvingDay>0){
            const daysUntilCalving=calvingDay-game.day;
            if(daysUntilCalving<=14 && daysUntilCalving>=0){
                if(!reproductionState.calving){
                    addNotification("Doğum Yaklaşıyor",cow.name+" için tahmini doğuma "+daysUntilCalving+" gün kaldı. Doğum alanı ve bakım planını hazırla.","warning",true);
                }
                reproductionState.calving=true;
            }else if(daysUntilCalving>14){
                reproductionState.calving=false;
            }
        }else{
            reproductionState.calving=false;
        }

        s.reproduction[id]=reproductionState;
        s.health[id]=h;
    });
    Object.keys(s.health).forEach(id=>{if(!activeIds.has(id))delete s.health[id];});
    Object.keys(s.sara).forEach(id=>{if(!activeIds.has(id))delete s.sara[id];});
    Object.keys(s.udder).forEach(id=>{if(!activeIds.has(id))delete s.udder[id];});
    Object.keys(s.milkDrop).forEach(id=>{if(!activeIds.has(id))delete s.milkDrop[id];});
    Object.keys(s.reproduction).forEach(id=>{if(!activeIds.has(id))delete s.reproduction[id];});
}

function renderMilkPerformance(){
    const chart=document.getElementById("milkDailyChart");
    const table=document.getElementById("milkPerformanceTable");
    const summary=document.getElementById("milkPerformanceSummary");
    if(!chart||!table||!summary) return;
    const daily={};
    game.cows.forEach(cow=>{
        (Array.isArray(cow.milkHistory)?cow.milkHistory:[]).forEach(item=>{
            const day=Number(item.day);
            const value=Number(item.yield)||0;
            if(!day||value<=0) return;
            daily[day]=(daily[day]||0)+value;
        });
    });
    const days=Object.keys(daily).map(Number).sort((a,b)=>b-a).slice(0,8).reverse();
    const maxDaily=Math.max(1,...days.map(day=>daily[day]));
    chart.innerHTML=days.length
        ? days.map(day=>{
            const value=daily[day];
            const height=Math.max(8,Math.round(value/maxDaily*100));
            return '<div class="milk-day-col"><div class="milk-day-value">'+value.toFixed(1)+'</div><div class="milk-day-track"><div class="milk-day-bar" style="height:'+height+'%"></div></div><div class="milk-day-label">Gün '+day+'</div></div>';
        }).join("")
        : '<div class="notification-empty w-full">Sağım geçmişi oluştuğunda günlük süt grafiği burada görünecek.</div>';
    const totalToday=Number(game.todayMilk)||0;
    const herd=game.cows.length;
    const avgPerCow=herd?totalToday/herd:0;
    summary.textContent=herd ? totalToday.toFixed(1)+" L bugün • "+avgPerCow.toFixed(1)+" L/baş" : "Sürü yok";
    const rows=game.cows.map(cow=>{
        const history=(Array.isArray(cow.milkHistory)?cow.milkHistory:[]).map(item=>Number(item.yield)||0).filter(v=>v>0);
        const latest=history[0]||0;
        const previous=history.slice(1,7);
        const previousAvg=previous.length?previous.reduce((a,b)=>a+b,0)/previous.length:0;
        const drop=previousAvg>0?((previousAvg-latest)/previousAvg)*100:0;
        const causes=[];
        if(cow.saraRisk>=50) causes.push("SARA riski");
        if(cow.health<80) causes.push("sağlık");
        if(cow.energyBalance<0) causes.push("negatif enerji");
        if(calculateDMI(cow)<10) causes.push("DMI düşük");
        if(cow.udderFill>=100) causes.push("meme doluluğu");
        if(!causes.length) causes.push("belirgin risk yok");
        return {cow,latest,avg:history.length?history.reduce((a,b)=>a+b,0)/history.length:0,drop,causes:causes.slice(0,2).join(" • ")};
    }).sort((a,b)=>b.latest-a.latest);
    table.innerHTML='<div class="milk-performance-row milk-performance-header"><div>Hayvan</div><div>Son</div><div>Ort.</div><div>Analiz</div></div>'+
        rows.map(row=>'<div class="milk-performance-row"><div><b>🐄 '+(row.cow.name||("İnek "+row.cow.id))+'</b></div><div class="green">'+row.latest.toFixed(1)+' L</div><div>'+row.avg.toFixed(1)+' L</div><div class="milk-cause '+(row.drop>=15?'red':'')+'">'+(row.drop>=15?'↓ %'+row.drop.toFixed(0)+' düşüş • ':'')+row.causes+'</div></div>').join("");
}

function renderAccountingCenter(){
    renderVeterinaryPayables();
    const bank=ensureBankState();
    const income=Number(game.income)||0;
    const expenses=Number(game.expenses)||0;
    const net=income-expenses;
    const cash=Number(game.money)||0;
    const debt=bank.loans.reduce((s,l)=>s+Math.max(0,Number(l.remaining)||0),0);
    const cows=Array.isArray(game.cows)?game.cows:[];
    const cowValue=cows.reduce((s,c)=>s+(c.isCalf?Math.min(25000,Math.max(5000,(Number(c.weight)||40)*120)):25000),0);
    const feedValue=Math.max(0,Number(game.feed)||0)*FEED_PRICE;
    const rawMilkValue=Math.max(0,Number(game.rawMilkStock)||0)*MILK_PRICE;
    const processed=(game.coldStorage||{});
    const processedValue=(Number(processed.pasteurizedMilk)||0)*32+(Number(processed.yogurt)||0)*55+(Number(processed.cheese)||0)*240;
    const assets=Math.max(0,cash+cowValue+feedValue+rawMilkValue+processedValue);
    const profitRate=income>0?Math.max(-100,Math.min(100,(net/income)*100)):0;
    const debtRate=assets>0?Math.max(0,Math.min(100,(debt/assets)*100)):0;
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
    const money=v=>Number(v||0).toLocaleString("tr-TR",{maximumFractionDigits:0})+" ₺";
    set("reportIncome",money(income));set("reportExpenses",money(expenses));set("reportNet",money(net));set("reportCash",money(cash));set("reportAssets",money(assets));set("reportDebt",money(debt));
    set("reportProfitRate",profitRate.toFixed(1)+"%");set("reportDebtRate",debtRate.toFixed(1)+"%");
    set("reportFeedValue",money(feedValue));set("reportRawMilkValue",money(rawMilkValue));set("reportProcessedValue",money(processedValue));
    const pb=document.getElementById("reportProfitBar");if(pb){pb.style.width=Math.min(100,Math.max(0,(profitRate+100)/2))+"%";pb.style.background=net>=0?"#22c55e":"#ef4444";}
    const db=document.getElementById("reportDebtBar");if(db)db.style.width=debtRate+"%";
    const badge=document.getElementById("accountingHealthBadge");if(badge){badge.textContent=net>=0&&debtRate<50?"● Sağlıklı":debtRate>=70?"● Borç Riski":"● Yakın İzleme";badge.className="accounting-status "+(net>=0&&debtRate<50?"":"blue-status");}
    const ledger=Array.isArray(game.accountingLedger)?game.accountingLedger:[];
    const recent=document.getElementById("reportRecentLedger");
    if(recent) recent.innerHTML=ledger.slice(0,6).map(x=>'<div><span>'+(x.category||"İşlem")+'</span><b class="'+(x.type==="Gelir"?"green":"red")+'">'+(x.type==="Gelir"?"+":"−")+money(x.amount)+'</b></div>').join("")||'<div>Henüz muhasebe hareketi yok.</div>';
}
function setupAccountingCenter(){
    /* Muhasebe alt menüleri kaldırıldı; finans bölümleri ana yan menüden açılır. */
    window.openAccountingPanel=function(id){
        const keyMap={
            "accounting-summary":"muhasebe",
            "accounting-report":"raporlar",
            "accounting-bank":"banka",
            "accounting-operations":"islemler",
            "accounting-processing":"sut-isleme"
        };
        const btn=document.querySelector(`#appMenu .menu-btn[data-menu="${keyMap[id]||"muhasebe"}"]`);
        if(btn) btn.click();
    };
}


function render(){

    updateFarmAtmosphere();
    updateRationAnalysis();
    renderAccountingCenter();


    document.getElementById(
        "gameClock"
    ).textContent =
        `Gün ${game.day} • ${formatGameTime()}`;

    document.querySelectorAll("#bigClock, #farmClockPanel").forEach(el=>el.textContent=formatGameTime());


    document.querySelectorAll("#dayText, #farmDayPanel").forEach(el=>el.textContent=`${game.day}. Gün`);


    const dayProgress =
        (
            game.minute/
            1440
        )*
        100;


    document.getElementById(
        "dayProgress"
    ).style.width =
        `${dayProgress}%`;


    document.getElementById(
        "dayProgressText"
    ).textContent =
        `${dayProgress.toFixed(1)}%`;


    animateDashboardNumber("herdKpi",game.cows.length,v=>Math.round(v).toLocaleString("tr-TR"));


    animateDashboardNumber("milkKpi",game.todayMilk,v=>`${v.toFixed(1)} L`);


    animateDashboardNumber("totalMilk",game.totalMilk,v=>`${v.toFixed(1)} L`);


    animateDashboardNumber("feedKpi",Math.max(0,game.feed),v=>`${v.toFixed(0)} kg`);


    animateDashboardNumber("moneyKpi",game.money,v=>`${Math.round(v).toLocaleString("tr-TR")} ₺`);


    const averageUdder =

        game.cows.length

        ?

        game.cows.filter(cow=>!cow.isCalf && cow.reproduction?.status!=="Kuru Dönem").length
        ?
        game.cows.filter(cow=>!cow.isCalf && cow.reproduction?.status!=="Kuru Dönem").reduce(
            (sum,cow)=>sum+(Number(cow.udderFill)||0),
            0
        )/
        game.cows.filter(cow=>!cow.isCalf && cow.reproduction?.status!=="Kuru Dönem").length
        :
        0

        :
        0;


    document.getElementById(
        "udderKpi"
    ).textContent =
        `${averageUdder.toFixed(1)}%`;


    const averagePH =

        game.cows.length

        ?

        game.cows.reduce(
            (
                sum,
                cow
            )=>
                sum+
                cow.rumenPH,
            0
        )/
        game.cows.length

        :
        0;


    document.getElementById(
        "rumenKpi"
    ).textContent =
        averagePH.toFixed(2);

    const worker=game.milkingWorker||{};
    const workerStatus=document.getElementById("milkingWorkerStatus");
    const workerDetail=document.getElementById("milkingWorkerDetail");
    const workerBtn=document.getElementById("hireMilkingWorkerBtn");
    if(workerStatus) workerStatus.textContent=worker.hired?"🟢 Görevde":"⚪ İşe alınmadı";
    if(workerDetail) workerDetail.textContent=worker.hired?"Programlı saatlerde otomatik sağım yapar • Günlük ücret: "+(Number(worker.dailyWage)||750).toLocaleString("tr-TR")+" ₺":"İşe alım: "+(Number(worker.hireCost)||2500).toLocaleString("tr-TR")+" ₺ • Günlük ücret: "+(Number(worker.dailyWage)||750).toLocaleString("tr-TR")+" ₺";
    if(workerBtn){workerBtn.textContent=worker.hired?"ÇALIŞIYOR":"İŞE AL";workerBtn.disabled=!!worker.hired;}

    const products=game.processedProducts||{pasteurizedMilk:0,yogurt:0,cheese:0};
    const cold=game.coldStorage||{pasteurizedMilk:0,yogurt:0,cheese:0};
    const queue=Array.isArray(game.processingQueue)?game.processingQueue:[];
    const tank=Number(game.rawMilkStock)||0;
    const cap=Number(game.rawMilkTankCapacity)||2000;
    [["rawMilkStock",tank.toFixed(1)+" / "+cap.toFixed(0)+" L"],["rawMilkKpi",tank.toFixed(1)+" L"],["pasteurizedMilkStock",(Number(cold.pasteurizedMilk)||0).toFixed(1)+" L"],["yogurtStock",(Number(cold.yogurt)||0).toFixed(1)+" kg"],["cheeseStock",(Number(cold.cheese)||0).toFixed(1)+" kg"]].forEach(([id,value])=>{const el=document.getElementById(id);if(el)el.textContent=value;});
    const bank=game.bank||{loans:[],grantApplications:[],totalGrantIncome:0};
    const loans=Array.isArray(bank.loans)?bank.loans:[];
    const debt=loans.reduce((s,l)=>s+Number(l.remaining||0),0);
    const bd=document.getElementById("bankDebt");if(bd)bd.textContent=debt.toLocaleString("tr-TR",{maximumFractionDigits:0})+" ₺";
    const bl=document.getElementById("bankLoanCount");if(bl)bl.textContent=loans.length;
    const bg=document.getElementById("bankGrantTotal");if(bg)bg.textContent=(Number(bank.totalGrantIncome)||0).toLocaleString("tr-TR")+" ₺";
    const pendingLoans=Array.isArray(bank.loanApplications)?bank.loanApplications:[];
    const pendingGrants=Array.isArray(bank.grantApplications)?bank.grantApplications:[];
    const alist=document.getElementById("bankApplicationsList");
    if(alist){
        const all=[...pendingLoans,...pendingGrants].slice(-8).reverse();
        alist.innerHTML=all.length?all.map(a=>{
            const isLoan=a.kind==="loan";
            const status=a.status==="İncelemede"?"🟡 İncelemede":a.status==="Onaylandı"?"🟢 Onaylandı":"🔴 Reddedildi";
            const detail=a.score!=null?" • Skor: "+a.score+"/100":" • Karar: "+Math.max(0,(Number(a.decisionDay)||0)-(Number(game.day)||0))+" gün";
            return '<div class="metric text-xs"><b>'+(isLoan?"💳 ":"🎁 ")+a.name+'</b> • '+Number(a.amount).toLocaleString("tr-TR")+' ₺ • '+status+detail+'</div>';
        }).join(""):'<div class="text-xs text-slate-500">Bekleyen banka başvurusu yok.</div>';
    }
    const blist=document.getElementById("bankLoansList");if(blist)blist.innerHTML=loans.length?loans.map((l,i)=>'<div class="metric text-xs"><b>'+l.name+'</b> • Kalan: '+Number(l.remaining).toLocaleString("tr-TR",{maximumFractionDigits:0})+' ₺ • Taksit: '+Number(l.installment).toLocaleString("tr-TR",{maximumFractionDigits:0})+' ₺ <button onclick="bankRepayLoan('+i+')" class="nav-btn ml-2">Taksiti Öde</button></div>').join(""):'<div class="text-xs text-slate-500">Aktif kredi yok.</div>';
    const glist=document.getElementById("grantApplicationsList");if(glist)glist.innerHTML=pendingGrants.slice(-5).reverse().map(a=>'<div class="metric text-xs">🎁 '+a.name+' • '+a.status+(a.score!=null?" • Skor: "+a.score+"/100":"")+' • '+Number(a.amount).toLocaleString("tr-TR")+' ₺</div>').join("");
    const factory=document.getElementById("processingQueueText");
    if(factory) factory.textContent=queue.length?queue.map(j=>({pasteurizedMilk:"Pastörize",yogurt:"Yoğurt",cheese:"Peynir"}[j.product]||j.product)+" • "+Math.ceil((Number(j.remainingMinutes)||0)/60)+" sa").join(" | "):"Hazır";
    const nextMilkingElement=document.getElementById("nextMilkingText");
    if(nextMilkingElement){
        try{
            const hours=getAutomaticMilkingHours();
            const now=Math.max(0,Math.min(1439,Number(game.minute)||0));
            let next=null;
            for(const h of hours){
                if(h*60>now){ next=h*60; break; }
            }
            if(next===null) next=hours[0]*60+1440;
            const diff=Math.max(0,next-now);
            const hh=Math.floor(diff/60);
            const mm=diff%60;
            const nextClock=formatMinutesToTime(next%1440);
            nextMilkingElement.textContent=`${nextClock} • ${hh} saat ${mm} dk`;
        }catch(e){
            nextMilkingElement.textContent="Program hazır";
        }
    }

    const feedDaysElement=document.getElementById("feedDaysText");
    if(feedDaysElement){
        try{
            const herdDmiPreview=game.cows.reduce((sum,cow)=>sum+calculateDMI(cow),0);
            const days=herdDmiPreview>0 ? Math.max(0,game.feed)/herdDmiPreview : 0;
            feedDaysElement.textContent=`${days.toFixed(1)} gün stok`;
        }catch(e){
            feedDaysElement.textContent="Veri hazır";
        }
    }

    const dashboardNet=document.getElementById("dashboardNet");
    if(dashboardNet){
        const netNow=game.income-game.expenses;
        dashboardNet.textContent=`${netNow.toLocaleString("tr-TR",{maximumFractionDigits:0})} ₺`;
        dashboardNet.className=netNow>=0 ? "green" : "red";
    }    
    const dashboardAlerts=document.getElementById("dashboardAlerts");
    const alertCount=document.getElementById("alertCount");
    if(dashboardAlerts && alertCount){
        const alerts=[];
        const lowFeed=game.feed<500;
        const criticalFeed=game.feed<200;
        const saraCount=game.cows.filter(c=>c.saraRisk>=50).length;
        const healthCount=game.cows.filter(c=>c.health<80).length;
        const fullUdderCount=game.cows.filter(c=>c.udderFill>=100).length;

        if(criticalFeed) alerts.push("🔴 Yem stoğu kritik: satın alma planlanmalı.");
        else if(lowFeed) alerts.push("🟡 Yem stoğu azalıyor: yeni yem alımı değerlendirilmeli.");

        if(saraCount) alerts.push(`🔴 ${saraCount} hayvanda subakut rumen asidozu (SARA) riski yüksek.`);
        if(healthCount) alerts.push(`🟡 ${healthCount} hayvan sağlık takibinde.`);
        if(fullUdderCount) alerts.push(`🔵 ${fullUdderCount} hayvanda meme doluluğu yüksek.`);

        if(!alerts.length) alerts.push("🟢 Aktif kritik uyarı yok. Çiftlik normal izleme durumunda.");

        alertCount.textContent=`${alerts.length} aktif`;
        dashboardAlerts.innerHTML=alerts.map(item=>`<div>${item}</div>`).join("");
    }




    const herdDMI =

        game.cows.reduce(
            (
                sum,
                cow
            )=>

                sum+
                calculateDMI(
                    cow
                ),

            0
        );


    document.getElementById(
        "dmiValue"
    ).textContent =
        `${herdDMI.toFixed(1)} kg`;


    document.getElementById(
        "feedCost"
    ).textContent =
        `${(
            herdDMI*
            FEED_PRICE
        ).toLocaleString(
            "tr-TR"
        )} ₺/gün`;


    document.getElementById(
        "income"
    ).textContent =
        `${game.income.toLocaleString(
            "tr-TR",
            {
                maximumFractionDigits:0
            }
        )} ₺`;


    document.getElementById(
        "expenses"
    ).textContent =
        `${game.expenses.toLocaleString(
            "tr-TR",
            {
                maximumFractionDigits:0
            }
        )} ₺`;


    const net =
        game.income-
        game.expenses;


    const netElement =
        document.getElementById(
            "netFinance"
        );


    netElement.textContent =
        `${net.toLocaleString(
            "tr-TR",
            {
                maximumFractionDigits:0
            }
        )} ₺`;


    netElement.className =
        net>=0
        ?
        "green"
        :
        "red";


    document.getElementById(
        "lastMilking"
    ).textContent =
        game.lastMilking||
        "Henüz yapılmadı";

    const overviewCash=document.getElementById("overviewCash");
    if(overviewCash){
        overviewCash.textContent=`${game.money.toLocaleString("tr-TR",{maximumFractionDigits:0})} ₺`;
    }

    const accountingBalance=document.getElementById("accountingBalance");
    const accountingExpenses=document.getElementById("accountingExpenses");

    if(accountingBalance){
        accountingBalance.textContent=
            `${game.money.toLocaleString("tr-TR",{maximumFractionDigits:0})} ₺`;
    }

    if(accountingExpenses){
        accountingExpenses.textContent=
            `${game.expenses.toLocaleString("tr-TR",{maximumFractionDigits:0})} ₺`;
    }
    const feed500Price=document.getElementById("feedBuy500Price");
    const feed1000Price=document.getElementById("feedBuy1000Price");
    if(feed500Price) feed500Price.textContent=(500*FEED_PRICE).toLocaleString("tr-TR",{maximumFractionDigits:0})+" ₺";
    if(feed1000Price) feed1000Price.textContent=(1000*FEED_PRICE).toLocaleString("tr-TR",{maximumFractionDigits:0})+" ₺";


    const accountingLog=document.getElementById("accountingLog");

    if(accountingLog){
        const ledger=game.accountingLedger||[];
        accountingLog.innerHTML=ledger.slice(0,8).map(item=>
            `<div class="log">
                Gün ${item.day} • ${item.time} | ${item.type} | ${item.category}: ${item.amount.toLocaleString("tr-TR")} ₺
            </div>`
        ).join("");
    }


    const feedStatus =
        document.getElementById(
            "feedStatus"
        );


    if(
        game.feed<200
    ){

        feedStatus.textContent=
            "KRİTİK";

        feedStatus.className=
            "text-xl font-bold red";

    }

    else if(
        game.feed<500
    ){

        feedStatus.textContent=
            "AZALIYOR";

        feedStatus.className=
            "text-xl font-bold yellow";

    }

    else{

        feedStatus.textContent=
            "NORMAL";

        feedStatus.className=
            "text-xl font-bold green";

    }


    [2,3,4].forEach(
        strategy=>{

            const button=
                document.getElementById(
                    "milking"+
                    strategy
                );


            button.classList.toggle(
                "active-strategy",
                game.milkingStrategy===
                strategy
            );

        }
    );


    renderRation();

    renderHerd();

    renderLogs();

}


/* =========================================================
   RESET
========================================================= */

function resetGame(){

    const confirmed=
        confirm(
            "Tüm çiftlik verileri silinsin mi?"
        );


    if(!confirmed)
        return;


    localStorage.removeItem(
        "ciftlikSimulasyonu"
    );


    localStorage.removeItem(
        "ciftlikLogs"
    );


    location.reload();

}


/* =========================================================
   GERÇEK ZAMAN
========================================================= */

let lastWorldGameMinute=null;

function getSharedWorldTime(){
    const elapsedRealSeconds=Math.max(
        0,
        (Date.now()-WORLD_CLOCK_EPOCH)/1000
    );

    const totalGameMinutes=
        WORLD_CLOCK_START_MINUTE+
        Math.floor(
            elapsedRealSeconds*
            GAME_MINUTES_PER_REAL_SECOND
        );

    const day=
        1+
        Math.floor(
            totalGameMinutes/GAME_MINUTES_PER_DAY
        );

    const minute=
        totalGameMinutes%GAME_MINUTES_PER_DAY;

    return {
        day,
        minute,
        totalGameMinutes
    };
}

function syncToSharedWorldClock(){
    const world=getSharedWorldTime();

    if(lastWorldGameMinute===null){
        lastWorldGameMinute=world.totalGameMinutes;
        game.day=world.day;
        game.minute=world.minute;
        return false;
    }

    const elapsedGameMinutes=
        world.totalGameMinutes-lastWorldGameMinute;

    if(elapsedGameMinutes<=0){
        game.day=world.day;
        game.minute=world.minute;
        return false;
    }

    /*
      Bütün kullanıcılar aynı dünya saatini izler.
      Biyolojik/ekonomik simülasyon ise geçen ortak oyun dakikaları
      kadar ilerletilir. Büyük sekmelerde tek seferde aşırı yük
      oluşturmamak için adım 120 oyun dakikasıyla sınırlandırılır.
    */
    const simulationStep=Math.min(elapsedGameMinutes,120);
    advanceGameTime(simulationStep);

    lastWorldGameMinute+=simulationStep;

    /* Saat göstergesi her zaman ortak dünya saatini gösterir. */
    game.day=world.day;
    game.minute=world.minute;

    return true;
}

function realTimeLoop(){
    const changed=syncToSharedWorldClock();

    if(changed){
        /* Simülasyon ilerlediğinde tam ekranı yeniden çiz. */
        render();
        saveGame();
    }else{
        /* Saat için her karede ağır render() çalıştırma.
           Bu, özellikle tablet/telefonlarda butonların dokunma
           tepkisini kilitleyebiliyordu. Sadece saat göstergesini güncelle. */
        const world=getSharedWorldTime();
        game.day=world.day;
        game.minute=world.minute;

        const clock=document.getElementById("gameClock");
        if(clock){
            const h=String(Math.floor(world.minute/60)%24).padStart(2,"0");
            const m=String(world.minute%60).padStart(2,"0");
            clock.textContent=`Gün ${world.day} • ${h}:${m}`;
        }

        const sharedClock=document.getElementById("sharedWorldClock");
        if(sharedClock) sharedClock.textContent="🌍 Ortak Dünya Saati • 6 dk/gün";

        /* Hafif saat göstergeleri her saniye ortak dünya saatine bağlanır. */
        const h=String(Math.floor(world.minute/60)%24).padStart(2,"0");
        const m=String(world.minute%60).padStart(2,"0");
        document.querySelectorAll("#bigClock, #farmClockPanel").forEach(el=>el.textContent=h+":"+m);
        document.querySelectorAll("#dayText, #farmDayPanel").forEach(el=>el.textContent=world.day+". Gün");
    }

    requestAnimationFrame(realTimeLoop);
}



/* =========================================================
   ÇİFTLİK ORTAM SESİ
   Web Audio API ile düşük seviyeli müzik yerine
   doğal çiftlik ambiyansı: inek, buzağı, horoz/kuş,
   ahır uğultusu ve su/yemlik sesleri.
========================================================= */

let farmAudio=null;

function createFarmNoiseBuffer(ctx){
    const buffer=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
    const data=buffer.getChannelData(0);
    let last=0;
    for(let i=0;i<data.length;i++){
        const white=Math.random()*2-1;
        last=last*0.985+white*0.015;
        data[i]=last*0.55;
    }
    return buffer;
}

/* =========================================================
   GERÇEK KAYITLI ÇİFTLİK SES SİSTEMİ
   Sentetik osilatörler tamamen kaldırıldı.
   Kaynaklar: Orange Free Sounds
   Lisans: CC BY 4.0 (ticari kullanım serbest, atıf gerekir)
========================================================= */

let FARM_AUDIO_CONFIG={
    enabled:true,
    url:"sounds/nature.wav",
    volume:0.45
};

const FARM_AUDIO_SOURCES={
    /* Varsayılan kaynak; ortak dünya ayarları açılınca Supabase'ten güncellenir. */
    get nature(){ return FARM_AUDIO_CONFIG.url; }
};

function createRealFarmAudio(src,volume=1,loop=false){
    /* GitHub Pages altında repo klasörü (/kpss-odak/) varsa bile doğru adresi üret. */
    const resolvedSrc=new URL(src,document.baseURI).href;
    const audio=document.createElement("audio");
    audio.preload="auto";
    audio.src=resolvedSrc;
    audio.volume=volume;
    audio.loop=loop;
    audio.setAttribute("playsinline","");
    return audio;
}

function playRealFarmSound(name,delay=0){
    if(!farmAudio || !farmAudio.enabled) return;
    const audio=farmAudio[name];
    if(!audio) return;

    if(delay){
        setTimeout(()=>playRealFarmSound(name),delay);
        return;
    }

    try{
        audio.currentTime=0;
        audio.volume=Math.max(0,Math.min(1,farmAudio.masterVolume*(name==="birds"?.20:name==="cow"?.38:.28)));
        audio.load();
        const promise=audio.play();
        if(promise && promise.catch) promise.catch(()=>{});
    }catch(error){}
}

function scheduleRealFarmSound(name,min,max){
    if(!farmAudio || !farmAudio.enabled) return;

    const timer=setTimeout(()=>{
        if(!farmAudio || !farmAudio.enabled) return;
        playRealFarmSound(name);
        scheduleRealFarmSound(name,min,max);
    },min+Math.random()*(max-min));

    farmAudio.timers.push(timer);
}

function startFarmAmbience(){
    try{
        const savedVolume=Number(localStorage.getItem("ciftlikSesSeviyesi")||FARM_AUDIO_CONFIG.volume);
        const masterVolume=FARM_AUDIO_CONFIG.enabled
            ? Math.max(0,Math.min(1,savedVolume))
            : 0;
        if(!farmAudio){
            const nature=createRealFarmAudio(FARM_AUDIO_SOURCES.nature,masterVolume*.45,true);
            farmAudio={enabled:true,masterVolume,nature,timers:[]};
            nature.addEventListener("error",()=>console.warn("Doğa ambiyansı yüklenemedi:",nature.src));
            nature.addEventListener("canplay",()=>console.log("Çiftlik ambiyansı hazır."));
        }else{
            farmAudio.enabled=true;
            farmAudio.masterVolume=masterVolume;
        }
        updateSoundUI(true);
        resumeFarmAudio();
        return true;
    }catch(error){
        console.warn("Doğa ambiyansı başlatılamadı:",error);
        updateSoundUI(false);
        return false;
    }
}

function resumeFarmAudio(){
    if(!farmAudio || !farmAudio.enabled) return;
    const audio=farmAudio.nature;
    if(!audio) return;
    try{
        audio.volume=Math.max(0,Math.min(1,farmAudio.masterVolume*.45));
        audio.muted=false;
        audio.autoplay=true;
        const p=audio.play();
        if(p && p.catch){
            p.catch(error=>{
                console.warn("Çiftlik sesi oynatılamadı:",error?.name||error);
                updateSoundUI(false,"⚠️ Sese dokunarak başlat");
            });
        }
    }catch(e){}
}

function stopFarmAmbience(){
    if(!farmAudio) return;
    try{
        (farmAudio.timers||[]).forEach(timer=>clearTimeout(timer));
        const audio=farmAudio.nature;
        if(audio){
            try{ audio.pause(); audio.currentTime=0; }catch(e){}
        }
    }catch(error){}
    farmAudio=null;
    updateSoundUI(false);
}


function setFarmVolume(value){
    const volume=Math.max(0,Math.min(100,Number(value)))/100;
    localStorage.setItem("ciftlikSesSeviyesi",volume);

    if(farmAudio){
        farmAudio.masterVolume=volume;
        if(farmAudio.nature) farmAudio.nature.volume=volume*.45;
    }

    const label=document.getElementById("soundLabel");
    if(label){
        label.textContent=volume===0
            ?"🔇 Ses kapalı"
            :`🔊 Çiftlik ambiyansı %${Math.round(volume*100)}`;
    }
}

function updateSoundUI(active,message=null){
    const button=document.getElementById("soundToggle");
    const label=document.getElementById("soundLabel");
    if(!button||!label) return;

    button.textContent=active?"🔇 Sesi Kapat":"🔊 Sesi Başlat";
    label.textContent=message || (active?"🌿 Doğa ambiyansı":"🔇 Ses kapalı");
    button.classList.toggle("active-sound",!!active);
}

/* Gerçek kayıtlar kullanıcı butonuyla başlatılır; mobil tarayıcı politikalarına uygundur. */
function setupFarmSound(){
    const slider=document.getElementById("soundVolume");
    const savedVolume=Number(localStorage.getItem("ciftlikSesSeviyesi")||0.55);
    const volume=Math.max(0,Math.min(1,savedVolume));
    if(slider) slider.value=Math.round(volume*100);
    if(slider) slider.addEventListener("input",e=>setFarmVolume(Number(e.target.value)));

    const toggle=document.getElementById("soundToggle");
    if(toggle){
        toggle.addEventListener("click",()=>{
            if(farmAudio && farmAudio.enabled){
                stopFarmAmbience();
            }else{
                startFarmAmbience();
            }
        });
    }

    updateSoundUI(false);

    /* İlk gerçek kullanıcı etkileşiminde sesi başlat. */
    const resumeOnce=()=>{
        if(!farmAudio || !farmAudio.enabled) startFarmAmbience();
        resumeFarmAudio();
    };
    document.addEventListener("pointerdown",resumeOnce,{once:true});
    document.addEventListener("keydown",resumeOnce,{once:true});
}




/* =========================================================
   ANA MENÜ
========================================================= */


let farmGameLayerTimer=null;
const FARM_EVENTS=[
  ["🥛","Sağım hattı","Bir sonraki sağım için sistem hazır.","CANLI"],
  ["🌾","Yemlikler kontrol altında","Rasyon ve yem tüketimi izleniyor.","CANLI"],
  ["🐄","Sürü aktif","Biyolojik göstergeler takip ediliyor.","CANLI"],
  ["📈","Üretim analizi","Bugünkü performans hesaplanıyor.","BUGÜN"]
];
function readKpiNumber(id){
  const el=document.getElementById(id);
  if(!el) return 0;
  const raw=String(el.textContent||"").replace(/\s/g,"").replace(/₺|L|kg|%/gi,"").replace(/\./g,"").replace(",",".");
  const n=parseFloat(raw);
  return Number.isFinite(n)?n:0;
}
function setGameText(id,value){const el=document.getElementById(id);if(el)el.textContent=value}
function renderFarmEvents(){
  const box=document.getElementById("farmEventFeed"); if(!box)return;
  const milk=readKpiNumber("milkKpi"),herd=readKpiNumber("herdKpi"),feed=readKpiNumber("feedKpi"),rumen=readKpiNumber("rumenKpi");
  const events=[...FARM_EVENTS];
  if(milk>0)events[0]=["🥛","Süt üretimi devam ediyor",milk.toLocaleString("tr-TR")+" L bugün üretildi.","CANLI"];
  if(feed>0)events[1]=["🌾","Yem stokları izleniyor",feed.toLocaleString("tr-TR")+" kg mevcut yem.","CANLI"];
  if(herd>0)events[2]=["🐄","Sürü sahada",herd.toLocaleString("tr-TR")+" baş hayvan aktif.","CANLI"];
  if(rumen>0&&rumen<5.8)events[3]=["⚠️","Rumen pH dikkat istiyor","Ortalama pH "+rumen.toFixed(1)+" — rasyonu kontrol et.","DİKKAT"];
  box.innerHTML=events.map(e=>'<div class="farm-event-item"><span class="farm-event-icon">'+e[0]+'</span><div><div class="farm-event-title">'+e[1]+'</div><div class="farm-event-meta">'+e[2]+'</div></div><span class="farm-event-time">'+e[3]+'</span></div>').join("");
}
function renderFarmGameHUD(){
  const herd=readKpiNumber("herdKpi"),milk=readKpiNumber("milkKpi"),feed=readKpiNumber("feedKpi"),money=readKpiNumber("moneyKpi"),rumen=readKpiNumber("rumenKpi");
  const level=Math.max(1,Math.min(20,Math.floor(herd/10)+1));
  const xp=Math.min(499,Math.max(80,Math.round((milk%5000)/10)));
  const score=Math.max(45,Math.min(99,Math.round(70+(herd?Math.min(15,herd/10):0)+(feed>1000?7:0)+(rumen>=5.8&&rumen<=6.6?8:2))));
  setGameText("farmLevelBadge",String(level).padStart(2,"0"));
  setGameText("farmLevelName",level>=10?"Uzman Çiftlik":level>=6?"Büyüyen Çiftlik":"Gelişen Çiftlik");
  setGameText("farmXpText",xp+" / 500 XP");
  const xpBar=document.getElementById("farmXpBar");if(xpBar)xpBar.style.width=(xp/5)+"%";
  setGameText("farmScore",score);
  const herdHealth=Math.max(60,Math.min(99,Math.round(88+(rumen>=5.8&&rumen<=6.6?6:0))));
  const feedHealth=Math.max(45,Math.min(99,feed>2000?95:feed>1000?86:feed>500?72:52));
  const productionHealth=Math.max(55,Math.min(99,Math.round(72+(milk>0?Math.min(20,milk/200):0))));
  const economyHealth=Math.max(50,Math.min(99,Math.round(65+(money>0?Math.min(25,money/10000):0))));
  [["gameHerdHealth",herdHealth],["gameFeedHealth",feedHealth],["gameProductionHealth",productionHealth],["gameEconomyHealth",economyHealth]].forEach(([id,v])=>{
    const el=document.getElementById(id);if(el){el.textContent=v;const bar=el.parentElement?.querySelector("div i");if(bar)bar.style.width=v+"%";}
  });
}
function renderDailyMission(){
  const target=3000,milk=readKpiNumber("milkKpi"),pct=Math.max(0,Math.min(100,Math.round(milk/target*100)));
  const bar=document.getElementById("missionProgress");if(bar)bar.style.width=pct+"%";
  setGameText("missionProgressText",pct+"%");
  setGameText("missionStatus",pct>=100?"✓ Görev tamamlandı":"Devam ediyor • "+milk.toLocaleString("tr-TR")+" / "+target.toLocaleString("tr-TR")+" L");
  setGameText("missionReward",pct>=100?"+250 XP KAZANILDI":"+250 XP");
  const action=document.getElementById("missionAction");if(action)action.textContent=pct>=100?"✓ TAMAMLANDI":"HEDEFİ TAKİP ET →";
}
function renderGameAlerts(){
  const box=document.getElementById("dashboardAlerts"),count=document.getElementById("alertCount");if(!box)return;
  const feed=readKpiNumber("feedKpi"),rumen=readKpiNumber("rumenKpi"),milk=readKpiNumber("milkKpi");
  const alerts=[];
  if(feed>0&&feed<500)alerts.push(["Yem stoğu azalıyor","Kritik seviyeye yaklaşmadan yem al."]);
  if(rumen>0&&rumen<5.8)alerts.push(["Rumen pH düşük","Rasyon ve nişasta yükünü kontrol et."]);
  if(milk>0&&milk<1500)alerts.push(["Süt üretimi düşük","Sağım ve sürü performansını incele."]);
  if(!alerts.length)alerts.push(["Çiftlik stabil","Şu anda kritik bir uyarı bulunmuyor."]);
  if(count)count.textContent=alerts.length+" aktif";
  box.innerHTML=alerts.map(a=>'<div class="game-alert-item">⚠️ <b>'+a[0]+'</b><br><span>'+a[1]+'</span></div>').join("");
}
function initGameLayer(){
  const refresh=()=>{renderFarmEvents();renderDailyMission();renderFarmGameHUD();renderGameAlerts()};
  refresh();
  if(farmGameLayerTimer)clearInterval(farmGameLayerTimer);
  farmGameLayerTimer=setInterval(refresh,5000);
  document.getElementById("missionAction")?.addEventListener("click",()=>document.getElementById("farmEventFeed")?.scrollIntoView({behavior:"smooth",block:"center"}));
  document.getElementById("heroMissionButton")?.addEventListener("click",()=>document.getElementById("missionAction")?.scrollIntoView({behavior:"smooth",block:"center"}));
}
function setupMobileMenu(){
    const menu=document.getElementById("appMenu");
    const toggle=document.getElementById("mobileMenuToggle");
    const backdrop=document.getElementById("mobileMenuBackdrop");
    if(!menu || !toggle) return;

    const close=()=>{
        menu.classList.remove("mobile-open");
        backdrop?.classList.remove("open");
        document.body.classList.remove("mobile-menu-open");
        toggle.setAttribute("aria-expanded","false");
        toggle.setAttribute("aria-label","Menüyü aç");
        toggle.textContent="☰";
    };
    const open=()=>{
        menu.classList.add("mobile-open");
        backdrop?.classList.add("open");
        document.body.classList.add("mobile-menu-open");
        toggle.setAttribute("aria-expanded","true");
        toggle.setAttribute("aria-label","Menüyü kapat");
        toggle.textContent="✕";
    };

    toggle.addEventListener("click",()=>{
        menu.classList.contains("mobile-open") ? close() : open();
    });
    backdrop?.addEventListener("click",close);
    menu.querySelectorAll(".menu-btn").forEach(btn=>{
        btn.addEventListener("click",()=>{
            if(window.matchMedia("(max-width:767px)").matches) close();
        });
    });
    window.addEventListener("resize",()=>{
        if(window.innerWidth>=768) close();
    });
    document.addEventListener("keydown",e=>{
        if(e.key==="Escape") close();
    });
}


function setupAppMenu(){
    const buttons=[...document.querySelectorAll("#appMenu .menu-btn")];
    const sections=[...document.querySelectorAll("[data-menu-section]")];

    /*
      Menü izolasyonu:
      Finans/Muhasebe bileşenleri de dahil olmak üzere her bölüm yalnızca
      kendi menüsü aktifken DOM'da görünür. "hidden" sınıfına ek olarak
      native hidden özelliğini kullanıyoruz; böylece Tailwind/CSS kuralları
      görünürlüğü yanlışlıkla geri açamaz.
    */
    const activate=(key)=>{
        buttons.forEach(b=>{
            b.classList.toggle("active-menu",b.dataset.menu===key);
            b.setAttribute("aria-selected",b.dataset.menu===key ? "true" : "false");
        });

        sections.forEach(s=>{
            const visible=s.dataset.menuSection===key;
            s.classList.toggle("hidden",!visible);
            s.hidden=!visible;
            s.setAttribute("aria-hidden",visible ? "false" : "true");
        });

        const main=document.querySelector("main");
        main?.classList.toggle("accounting-layout",key==="muhasebe");

        /* Her menüyü ayrı bir çalışma ekranı olarak işaretle. */
        main?.setAttribute("data-active-menu",key);
        document.body.setAttribute("data-active-menu",key);

        /*
          Muhasebe dışındaki ekranlarda herhangi bir finans özetinin
          görünür kalmasını garanti altına al.
        */
        window.scrollTo({top:0,behavior:"smooth"});
    };

    buttons.forEach(b=>b.addEventListener("click",()=>activate(b.dataset.menu)));
    activate("genel");
}


/* =========================================================
   BOOT
========================================================= */

let farmAppInitialized=false;

function initFarmApp(){
    if(farmAppInitialized) return true;

    /* Giriş ekranının ana uygulamayı kilitlemesine izin verme. */
    try{
        document.getElementById("app")?.classList.remove("hidden-screen");
        setupAppMenu();
        setupMobileMenu();
        initGameLayer();
        setupAccountingCenter();
        setupNotifications();
        setupAnimalCardModal();
        setupFarmSound();
        render();
        initSharedBackend();
        processAutomaticMilking();
        realTimeLoop();
        addLog("Çiftlik Simülasyonu başlatıldı.");
        saveGame();
        farmAppInitialized=true;
        return true;
    }catch(error){
        console.error("Çiftlik başlatma hatası:",error);
        /* Kritik olmayan bir modül hata verse bile uygulamaya girilebilir. */
        document.getElementById("app")?.classList.remove("hidden-screen");
        farmAppInitialized=true;
        return false;
    }
}

function boot(){
    document.getElementById("bootScreen")?.remove();
    initFarmApp();

    /* Sayfa açılır açılmaz çiftlik ambiyansını başlatmayı dene. */
    try{
        startFarmAmbience();
        resumeFarmAudio();
    }catch(e){}

    /* Tarayıcı autoplay'i engellerse ilk kullanıcı etkileşiminde anında tekrar dene. */
    const unlockAudio=()=>{
        try{
            startFarmAmbience();
            resumeFarmAudio();
        }catch(e){}
    };
    ["pointerdown","touchstart","keydown"].forEach(type=>{
        document.addEventListener(type,unlockAudio,{once:true,passive:true});
    });
}


/* =========================================================
   BAŞLAT
========================================================= */

/*
  Başlangıç sırası:
  Kayıt verisi önce güvenli şekilde yüklenir, ağır offline hesap
  sınırlı tutulur; ardından giriş ekranı açılır.
*/
try{
    loadGame();
}catch(error){
    console.error("Kayıt yükleme hatası:",error);
    try{
        createInitialHerd();
        updateRationAnalysis();
    }catch(e){
        console.error("İlk çiftlik oluşturulamadı:",e);
    }
}

boot();